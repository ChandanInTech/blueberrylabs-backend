import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import * as envModule from "../../src/config/env";
import { getDatabase, getDb } from "../../src/db/client";
import { generations, jobs } from "../../src/db/schema";
import { Worker } from "../../src/queue/worker";
import { setStorageForTesting } from "../../src/services/storage";
import { imageMetadata, makeImage } from "../fixtures";
import type { TestSession } from "../harness";
import { authedHeaders, bootTestRuntime, createSession, resetSingletons, truncateAll } from "../harness";
import { setupTestDatabase, teardownTestDatabase, testDatabaseUrl } from "../setup-env";

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

let app: ReturnType<typeof createApp>;
let url: string;

beforeAll(async () => {
  bootTestRuntime();
  process.env.DATABASE_URL = testDatabaseUrl();
  envModule.resetEnvCache();
  await setupTestDatabase();
  app = createApp();
  app.listen(0);
  url = `http://localhost:${app.server!.port}`;

  // The filesystem storage adapter mints presigned URLs from API_PUBLIC_URL;
  // point it at the ephemeral test port.
  process.env.API_PUBLIC_URL = url;
  // These suites create many generations deliberately; the limiter has its own
  // dedicated test file.
  process.env.RATE_LIMIT_GENERATION_PER_MINUTE = "1000";
  process.env.RATE_LIMIT_UPLOAD_PER_MINUTE = "1000";
  process.env.RATE_LIMIT_STATUS_PER_MINUTE = "1000";
  process.env.RATE_LIMIT_DOWNLOAD_URL_PER_MINUTE = "1000";
  process.env.MAX_GENERATIONS_PER_USER_PER_DAY = "1000";
  process.env.MAX_CONCURRENT_GENERATIONS_PER_USER = "100";
  envModule.resetEnvCache();
  setStorageForTesting(null);
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await resetSingletons();
  await teardownTestDatabase();
}, 30_000);

beforeEach(async () => {
  await truncateAll();
});

/** Run the queue loop manually so tests stay deterministic (no polling races). */
async function drainQueue(maxRounds = 10): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    const remaining = await getDatabase()
      .client`SELECT count(*)::int AS n FROM jobs WHERE status IN ('QUEUED','RUNNING')`;
    if (Number(remaining[0]?.n ?? 0) === 0) return;
    const runner = new Worker({ pollIntervalMs: 10, concurrency: 1 });
    await runner.runOnce();
  }
}

/** Upload bytes the way the browser does: presigned PUT, then complete. */
async function uploadImage(
  session: TestSession,
  bytes: Uint8Array,
  contentType = "image/png",
  filename = "photo.png",
): Promise<string> {
  const createResponse = await fetch(`${url}/api/v1/uploads`, {
    method: "POST",
    headers: authedHeaders(session, { "content-type": "application/json" }),
    body: JSON.stringify({ filename, contentType, sizeBytes: bytes.byteLength }),
  });
  expect(createResponse.status).toBe(201);
  const created = await json<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>(
    createResponse,
  );

  const put = await fetch(created.uploadUrl, {
    method: "PUT",
    headers: { ...created.headers },
    body: bytes,
  });
  expect(put.status).toBe(200);

  const complete = await fetch(`${url}/api/v1/uploads/${created.assetId}/complete`, {
    method: "POST",
    headers: authedHeaders(session),
  });
  expect(complete.status).toBe(200);
  expect((await json(complete)).uploadStatus).toBe("UPLOADED");

  return created.assetId;
}

describe("end-to-end generation pipeline", () => {
  test("uploads, enqueues, processes, and exposes a signed download", async () => {
    const session = await createSession(url);
    const source = await makeImage(800, 600, { format: "png" });
    const assetId = await uploadImage(session, source);

    const createResponse = await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers: {
        ...authedHeaders(session, { "content-type": "application/json" }),
        "idempotency-key": "test-key-1",
      },
      body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "PORTRAIT" }),
    });

    expect(createResponse.status).toBe(202);
    const created = await json<{ generationId: string; status: string; progress: number }>(createResponse);
    expect(created.status).toBe("QUEUED");
    expect(created.progress).toBe(0);

    // A queued generation must be visible immediately, before processing.
    const before = await fetch(`${url}/api/v1/generations/${created.generationId}`, {
      headers: authedHeaders(session),
    });
    const beforeBody = await json(before);
    expect(beforeBody.status).toBe("QUEUED");
    expect(beforeBody.output).toBeNull();

    await drainQueue();

    const after = await fetch(`${url}/api/v1/generations/${created.generationId}`, {
      headers: authedHeaders(session),
    });
    expect(after.status).toBe(200);
    const afterBody = await json(after);

    expect(afterBody.status).toBe("COMPLETED");
    expect(afterBody.progress).toBe(100);
    expect(afterBody.currentStep).toBe("COMPLETED");
    expect(afterBody.output).toMatchObject({ width: 1080, height: 1350, mimeType: "image/jpeg" });
    expect(afterBody.output.sizeBytes).toBeGreaterThan(0);

    // The status response must not leak storage internals.
    expect(JSON.stringify(afterBody)).not.toContain("generated/");
    expect(JSON.stringify(afterBody)).not.toContain("media-generated");

    const download = await fetch(`${url}/api/v1/generations/${created.generationId}/download-url`, {
      method: "POST",
      headers: authedHeaders(session),
    });
    expect(download.status).toBe(200);
    const signed = await json<{ url: string; filename: string; mimeType: string }>(download);
    expect(signed.filename).toBe("instagram-portrait.jpg");

    const bytes = new Uint8Array(await (await fetch(signed.url)).arrayBuffer());
    const meta = await imageMetadata(bytes);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  }, 60_000);

  test("all five presets produce their exact dimensions", async () => {
    const session = await createSession(url);
    const source = await makeImage(640, 480);
    const presets: Array<[string, string, number, number]> = [
      ["INSTAGRAM", "SQUARE", 1080, 1080],
      ["INSTAGRAM", "PORTRAIT", 1080, 1350],
      ["INSTAGRAM", "STORY", 1080, 1920],
      ["TIKTOK", "COVER", 1080, 1920],
      ["YOUTUBE", "THUMBNAIL", 1280, 720],
    ];

    for (const [platform, format, width, height] of presets) {
      const assetId = await uploadImage(session, source, "image/jpeg", "photo.jpg");
      const createResponse = await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ assetId, platform, format }),
      });
      expect(createResponse.status).toBe(202);
      const created = await json<{ generationId: string }>(createResponse);

      await drainQueue();

      const status = await json(
        await fetch(`${url}/api/v1/generations/${created.generationId}`, {
          headers: authedHeaders(session),
        }),
      );
      expect(status.status).toBe("COMPLETED");
      expect(status.output.width).toBe(width);
      expect(status.output.height).toBe(height);

      const signed = await json<{ url: string }>(
        await fetch(`${url}/api/v1/generations/${created.generationId}/download-url`, {
          method: "POST",
          headers: authedHeaders(session),
        }),
      );
      const bytes = new Uint8Array(await (await fetch(signed.url)).arrayBuffer());
      const meta = await imageMetadata(bytes);
      expect([meta.width, meta.height]).toEqual([width, height]);
    }
  }, 120_000);

  test("the same idempotency key returns the same generation", async () => {
    const session = await createSession(url);
    const assetId = await uploadImage(session, await makeImage(200, 200));
    const headers = {
      ...authedHeaders(session, { "content-type": "application/json" }),
      "idempotency-key": "stable-key",
    };
    const body = JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" });

    const first = await json<{ generationId: string }>(
      await fetch(`${url}/api/v1/generations`, { method: "POST", headers, body }),
    );
    const second = await json<{ generationId: string }>(
      await fetch(`${url}/api/v1/generations`, { method: "POST", headers, body }),
    );

    expect(second.generationId).toBe(first.generationId);

    const rows = await getDatabase().client`SELECT count(*)::int AS n FROM generations`;
    expect(Number(rows[0]?.n)).toBe(1);
  }, 30_000);

  test("reusing a key with a different payload conflicts", async () => {
    const session = await createSession(url);
    const source = await makeImage(200, 200);
    const assetId = await uploadImage(session, source);

    const headers = {
      ...authedHeaders(session, { "content-type": "application/json" }),
      "idempotency-key": "reused-key",
    };

    await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" }),
    });

    const conflict = await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assetId, platform: "YOUTUBE", format: "THUMBNAIL" }),
    });
    expect(conflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(conflict)).error.code).toBe("IDEMPOTENCY_CONFLICT");
  }, 30_000);

  test("rejects an unsupported platform/format pair", async () => {
    const session = await createSession(url);
    const assetId = await uploadImage(session, await makeImage(200, 200));

    const response = await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers: authedHeaders(session, { "content-type": "application/json" }),
      body: JSON.stringify({ assetId, platform: "TIKTOK", format: "SQUARE" }),
    });
    // TypeBox rejects it at the edge before the handler runs.
    expect(response.status).toBe(400);
  }, 30_000);

  test("rejects a generation for another user's asset", async () => {
    const alice = await createSession(url);
    const bob = await createSession(url);
    const assetId = await uploadImage(alice, await makeImage(200, 200));

    const response = await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers: authedHeaders(bob, { "content-type": "application/json" }),
      body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" }),
    });
    expect(response.status).toBe(404);
  }, 30_000);

  test("rejects a generation from an unverified asset", async () => {
    const session = await createSession(url);
    const createResponse = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: authedHeaders(session, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "x.png", contentType: "image/png", sizeBytes: 100 }),
    });
    const { assetId } = await json<{ assetId: string }>(createResponse);

    const response = await fetch(`${url}/api/v1/generations`, {
      method: "POST",
      headers: authedHeaders(session, { "content-type": "application/json" }),
      body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" }),
    });
    expect(response.status).toBe(409);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("UPLOAD_NOT_COMPLETE");
  }, 30_000);

  test("a corrupt image fails the generation permanently", async () => {
    const session = await createSession(url);
    const assetId = await uploadImage(
      session,
      new Uint8Array(Buffer.from("not an image at all")),
      "image/png",
      "broken.png",
    );

    const created = await json<{ generationId: string }>(
      await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" }),
      }),
    );

    await drainQueue();

    const status = await json(
      await fetch(`${url}/api/v1/generations/${created.generationId}`, {
        headers: authedHeaders(session),
      }),
    );
    expect(status.status).toBe("FAILED");
    expect(status.error.code).toBe("PROCESSING_FAILED");

    const [job] = await getDb().select().from(jobs).where(eq(jobs.status, "FAILED")).limit(1);
    expect(job).toBeDefined();
    expect(job!.attempts).toBe(1); // permanent: no retries burned
  }, 30_000);

  test("job is durable across a simulated process restart", async () => {
    const session = await createSession(url);
    const assetId = await uploadImage(session, await makeImage(300, 300));
    const created = await json<{ generationId: string }>(
      await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ assetId, platform: "YOUTUBE", format: "THUMBNAIL" }),
      }),
    );

    // "Restart": close and reopen the pool, then process on a brand new worker.
    await resetSingletons();
    envModule.resetEnvCache();

    const queued = await getDatabase().client`SELECT count(*)::int AS n FROM jobs WHERE status = 'QUEUED'`;
    expect(Number(queued[0]?.n)).toBe(1);

    await drainQueue();

    const status = await json(
      await fetch(`${url}/api/v1/generations/${created.generationId}`, {
        headers: authedHeaders(session),
      }),
    );
    expect(status.status).toBe("COMPLETED");
  }, 60_000);

  test("a redelivered job does not create a second output asset", async () => {
    const session = await createSession(url);
    const assetId = await uploadImage(session, await makeImage(300, 300));
    const created = await json<{ generationId: string }>(
      await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "STORY" }),
      }),
    );

    await drainQueue();

    const first = await getDatabase()
      .client`SELECT count(*)::int AS n FROM assets WHERE upload_status = 'UPLOADED'`;

    // Redeliver: put the job back in the queue as if the lease had been lost.
    await getDb()
      .update(jobs)
      .set({ status: "QUEUED", runAt: new Date() })
      .where(eq(jobs.status, "COMPLETED"));
    await drainQueue();

    const second = await getDatabase()
      .client`SELECT count(*)::int AS n FROM assets WHERE upload_status = 'UPLOADED'`;
    expect(second[0]?.n).toBe(first[0]?.n);

    const row = await getDb()
      .select()
      .from(generations)
      .where(eq(generations.id, created.generationId))
      .limit(1);
    expect(row[0]?.status).toBe("COMPLETED");
  }, 60_000);

  test("lists generations newest first with cursor pagination", async () => {
    const session = await createSession(url);
    const source = await makeImage(120, 120);

    for (let i = 0; i < 3; i += 1) {
      const assetId = await uploadImage(session, source);
      await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ assetId, platform: "INSTAGRAM", format: "SQUARE" }),
      });
    }

    const page1 = await json<{ items: any[]; nextCursor: string | null }>(
      await fetch(`${url}/api/v1/generations?limit=2`, { headers: authedHeaders(session) }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeString();

    const page2 = await json<{ items: any[]; nextCursor: string | null }>(
      await fetch(`${url}/api/v1/generations?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
        headers: authedHeaders(session),
      }),
    );
    expect(page2.items).toHaveLength(1);

    const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
    expect(ids.size).toBe(3);
  }, 60_000);
});

describe("upload validation at the edge", () => {
  test("rejects an unsupported content type", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: authedHeaders(session, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 1000 }),
    });
    expect(response.status).toBe(415);
  }, 30_000);

  test("rejects a file larger than the configured limit", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: authedHeaders(session, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "huge.png", contentType: "image/png", sizeBytes: 26 * 1024 * 1024 }),
    });
    expect(response.status).toBe(413);
  }, 30_000);

  test("completion fails when the object was never uploaded", async () => {
    const session = await createSession(url);
    const created = await json<{ assetId: string }>(
      await fetch(`${url}/api/v1/uploads`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ filename: "ghost.png", contentType: "image/png", sizeBytes: 500 }),
      }),
    );

    const response = await fetch(`${url}/api/v1/uploads/${created.assetId}/complete`, {
      method: "POST",
      headers: authedHeaders(session),
    });
    expect(response.status).toBe(422);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("UPLOAD_VERIFICATION_FAILED");
  }, 30_000);

  test("a forged presigned upload URL is rejected", async () => {
    const response = await fetch(
      `${url}/__storage/media-originals/originals/attacker/x/source?expires=${Date.now() + 60_000}&contentType=image/png&signature=forged`,
      { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) },
    );
    expect(response.status).toBe(403);
  }, 30_000);

  test("an expired presigned upload URL is rejected", async () => {
    const session = await createSession(url);
    const created = await json<{ uploadUrl: string }>(
      await fetch(`${url}/api/v1/uploads`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({ filename: "late.png", contentType: "image/png", sizeBytes: 10 }),
      }),
    );

    const expired = new URL(created.uploadUrl);
    expired.searchParams.set("expires", String(Date.now() - 1000));

    const response = await fetch(expired.toString(), {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(403);
  }, 30_000);
});

export { json };
