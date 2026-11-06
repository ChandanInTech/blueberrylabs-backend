import { getEnv } from "../config/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Correlation fields propagated through a request/job lifecycle. */
export interface LogContext {
  requestId?: string;
  traceId?: string;
  userId?: string;
  assetId?: string;
  generationId?: string;
  jobId?: string;
  route?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface LogRecord extends LogContext {
  timestamp: string;
  level: LogLevel;
  service: "api" | "worker";
  event: string;
  message?: string;
}

/** Field names that must never reach the log stream. */
const REDACTED_KEYS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "token",
  "tokenHash",
  "uploadUrl",
  "url",
  "signedUrl",
  "secret",
  "password",
  "accessKeyId",
  "secretAccessKey",
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : redact(entry, depth + 1);
  }
  return out;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack && getEnv().NODE_ENV !== "production"
        ? { stack: error.stack.split("\n").slice(0, 6).join("\n") }
        : {}),
    };
  }
  return { errorMessage: String(error) };
}

class Logger {
  constructor(private readonly service: "api" | "worker") {}

  private emit(level: LogLevel, event: string, context: LogContext = {}): void {
    const configured = getEnv().LOG_LEVEL;
    if (LEVEL_RANK[level] < LEVEL_RANK[configured]) return;

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...(redact(context) as LogContext),
    };

    const line = JSON.stringify(record);
    if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(event: string, context?: LogContext): void {
    this.emit("debug", event, context);
  }
  info(event: string, context?: LogContext): void {
    this.emit("info", event, context);
  }
  warn(event: string, context?: LogContext): void {
    this.emit("warn", event, context);
  }
  error(event: string, context?: LogContext): void {
    this.emit("error", event, context);
  }

  /** Log an unexpected failure with a serialized error attached. */
  exception(event: string, error: unknown, context: LogContext = {}): void {
    this.emit("error", event, { ...context, ...serializeError(error) });
  }

  /** A logger that always carries the given correlation context. */
  child(context: LogContext): ScopedLogger {
    return new ScopedLogger(this, context);
  }
}

class ScopedLogger {
  constructor(
    private readonly inner: Logger,
    private readonly context: LogContext,
  ) {}

  debug(event: string, context?: LogContext): void {
    this.inner.debug(event, { ...this.context, ...context });
  }
  info(event: string, context?: LogContext): void {
    this.inner.info(event, { ...this.context, ...context });
  }
  warn(event: string, context?: LogContext): void {
    this.inner.warn(event, { ...this.context, ...context });
  }
  error(event: string, context?: LogContext): void {
    this.inner.error(event, { ...this.context, ...context });
  }
  exception(event: string, error: unknown, context?: LogContext): void {
    this.inner.exception(event, error, { ...this.context, ...context });
  }
  child(context: LogContext): ScopedLogger {
    return new ScopedLogger(this.inner, { ...this.context, ...context });
  }
}

export const logger = new Logger("api");
export const workerLogger = new Logger("worker");
export type { Logger, ScopedLogger };
