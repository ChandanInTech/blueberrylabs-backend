# blueberrylabs-backend

Bun + Elysia API, PostgreSQL-backed job queue, and Sharp image worker — one process,
one Railway service.

```bash
bun install
cp .env.example .env      # set DATABASE_URL + DEMO_SESSION_SECRET
bun run db:migrate
bun run dev               # http://localhost:3001
```

```bash
bun run test              # unit + integration (starts its own PostgreSQL if needed)
bun run typecheck
bun run lint
bun run contracts:build   # compiles the shared contracts package
```

## Layout

```
src/
├── app.ts                      Elysia composition root (CORS, request context, errors)
├── server.ts                   boot: DB probe, HTTP listen, worker start, graceful shutdown
├── config/env.ts               validated environment (zod); fails fast on bad config
├── db/
│   ├── client.ts               postgres-js pool + drizzle
│   ├── schema/index.ts         tables, indexes, CHECK constraints
│   ├── migrations/             checked-in SQL (0000 schema, 0001 rate-limit SQL functions)
│   └── migrate.ts              controlled migration runner
├── middleware/
│   ├── auth.ts                 session + CSRF resolution
│   ├── origin.ts               Origin allow-list
│   ├── rate-limit.ts           atomic fixed-window limiter + rule set
│   ├── request-context.ts      per-request ctx (requestId, userId, clientIp)
│   └── error-handler.ts        single public error shape
├── modules/
│   ├── auth/                   demo sessions
│   ├── uploads/                presign + verify
│   ├── assets/                 (routes live with uploads)
│   ├── generations/            create/status/list/download-url
│   └── health/                 live + ready
├── queue/
│   ├── worker.ts               bounded-concurrency loop, leases, timeouts
│   ├── claim-job.ts            FOR UPDATE SKIP LOCKED claim + recovery
│   ├── retry.ts                exponential backoff with jitter
│   └── handlers/process-image.ts
├── services/
│   ├── storage/                StorageService + Railway S3 + filesystem adapters
│   ├── image/sharp-processor.ts
│   └── generation/             transactional enqueue + quotas
└── observability/              JSON logs, metrics, optional OTel, cleanup task
```

## Queue semantics

- **Claiming** is one statement: `WITH … FOR UPDATE SKIP LOCKED LIMIT 1` then `UPDATE …
  RETURNING`. Two replicas can never take the same job; verified in `test/integration/queue.test.ts`.
- **Priority** is `ORDER BY priority DESC, created_at ASC`.
- **Leases**: `locked_at` is refreshed every third of `WORKER_JOB_LEASE_SECONDS`. A job
  whose lease expires is requeued (attempts remaining) or failed, and its generation is
  reconciled out of `PROCESSING`.
- **Retry**: exponential backoff with jitter — attempt 1 fails → ~5 s, attempt 2 → ~15 s,
  attempt 3 → terminal. `JobError.retryable` distinguishes transient storage/network
  problems from permanent input errors (bad image, unsupported preset).
- **Idempotency**: the handler returns early on a terminal generation, and the output
  object key is deterministic per generation, so a redelivered job overwrites rather
  than creating a second output asset.
- **Shutdown**: `SIGTERM`/`SIGINT` stop claiming, wait for in-flight work, then release
  anything unfinished back to the queue without consuming an attempt.

## Rate limiting

`consume_rate_limit(key, limit, window)` is a `plpgsql` function that performs the
whole decision in one `INSERT … ON CONFLICT DO UPDATE`:

```sql
SELECT * FROM consume_rate_limit('<sha256 key>', 3, 60);
--  allowed | remaining | reset_at
```

Keys are SHA-256 hashes of `secret:operation:dimension:value`, so raw IPs and user ids
are never persisted. Each rule is evaluated per configured dimension (user and/or IP)
and fails on the strictest result.

## Image output

- `fit: "cover"`, `position: "centre"` — crop, never stretch.
- `rotate()` honours EXIF orientation before cropping.
- Opaque sources → JPEG at `IMAGE_JPEG_QUALITY` (mozjpeg, 4:4:4).
- Alpha sources → PNG, preserving transparency. Flattening is only used when
  `IMAGE_PRESERVE_TRANSPARENCY=false`, and it composites onto
  `IMAGE_TRANSPARENT_BACKGROUND` rather than silently discarding alpha.
- Metadata (EXIF/ICC) is stripped.
- `limitInputPixels` guards against decompression bombs; exceeding it maps to
  `IMAGE_TOO_LARGE` rather than a generic decode failure.

## Observability

Every request gets an `X-Request-Id` (honouring a valid inbound one) and a JSON log
line for completion and failure. Worker logs carry `jobId` and `generationId` so one
generation can be traced end to end. `/metrics` exposes Prometheus text: request
counts/latency, rate-limit rejections, upload counters, queue depth, job
started/completed/failed/retried/recovered, and processing durations. Metric labels are
deliberately low-cardinality — ids belong in logs.

## Tracing (OpenTelemetry)

Elysia's first-party `@elysia/opentelemetry` plugin — grouped lifecycle spans
per request plus `record` worker spans, with `traceId` on every log line.
Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector base URL (e.g.
`http://otel-collector:4318`) to export traces over OTLP/HTTP;
`OTEL_SERVICE_NAME` defaults to `blueberrylabs-backend`. Without an endpoint
the plugin is not applied, so logs and `/metrics` work as before. Library
auto-instrumentation is disabled: Bun only partially supports the Node
patching it needs.
