import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { resetEnvCache } from "../../src/config/env";
import {
  currentTraceId,
  isTracingEnabled,
  markCurrentSpanError,
  tracingPlugin,
  withSpan,
} from "../../src/observability/tracing";

process.env.DATABASE_URL = "postgresql://app:app@localhost:5432/test";
process.env.JWT_SECRET = "a".repeat(32);
process.env.STORAGE_DRIVER = "filesystem";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
resetEnvCache();

describe("tracing helpers", () => {
  test("is disabled without an OTLP endpoint (tests never set one)", () => {
    expect(isTracingEnabled()).toBe(false);
  });

  test("tracingPlugin is a no-op Elysia instance when disabled", () => {
    const plugin = tracingPlugin();
    expect(plugin).toBeInstanceOf(Elysia);
  });

  test("currentTraceId is undefined outside a span", () => {
    expect(currentTraceId()).toBeUndefined();
  });

  test("withSpan runs the callback and returns its value when disabled", async () => {
    const result = await withSpan("worker.job", { "job.type": "PROCESS_IMAGE" }, async () => 42);
    expect(result).toBe(42);
  });

  test("withSpan rethrows callback errors when disabled", async () => {
    await expect(
      withSpan("worker.job", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("markCurrentSpanError is a safe no-op outside a span", () => {
    expect(() => markCurrentSpanError(new Error("boom"))).not.toThrow();
  });
});
