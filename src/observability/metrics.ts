/**
 * Minimal in-process metrics registry.
 *
 * Deliberately low-cardinality: labels are route/status/operation only. User,
 * generation, job and request IDs belong in logs, never in metric labels.
 *
 * Exposed as Prometheus text format on `/metrics`.
 */

export type MetricKind = "counter" | "histogram";

interface CounterState {
  kind: "counter";
  help: string;
  values: Map<string, number>;
}

interface HistogramState {
  kind: "histogram";
  help: string;
  buckets: number[];
  series: Map<string, { counts: number[]; sum: number; count: number }>;
}

type MetricState = CounterState | HistogramState;

const registry = new Map<string, MetricState>();

/** Default latency buckets in seconds. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}="${String(labels[key]).replace(/["\\\n]/g, "_")}"`).join(",");
}

export function defineCounter(name: string, help: string): void {
  if (!registry.has(name)) registry.set(name, { kind: "counter", help, values: new Map() });
}

export function defineHistogram(name: string, help: string, buckets = DEFAULT_BUCKETS): void {
  if (!registry.has(name)) {
    registry.set(name, {
      kind: "histogram",
      help,
      buckets: [...buckets].sort((a, b) => a - b),
      series: new Map(),
    });
  }
}

export function increment(name: string, labels: Record<string, string> = {}, by = 1): void {
  const metric = registry.get(name);
  // biome-ignore lint/complexity/useOptionalChain: explicit null guard, not a chain
  if (!metric || metric.kind !== "counter") return;
  const key = labelKey(labels);
  metric.values.set(key, (metric.values.get(key) ?? 0) + by);
}

export function observe(name: string, value: number, labels: Record<string, string> = {}): void {
  const metric = registry.get(name);
  // biome-ignore lint/complexity/useOptionalChain: explicit null guard, not a chain
  if (!metric || metric.kind !== "histogram") return;
  const key = labelKey(labels);
  let series = metric.series.get(key);
  if (!series) {
    series = { counts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 };
    metric.series.set(key, series);
  }
  series.sum += value;
  series.count += 1;
  for (let i = 0; i < metric.buckets.length; i += 1) {
    const bound = metric.buckets[i];
    if (bound !== undefined && value <= bound) series.counts[i] = (series.counts[i] ?? 0) + 1;
  }
}

export function setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
  defineCounter(`${name}__gauge_holder`, "internal");
  const key = labelKey(labels);
  gaugeValues.set(`${name}|${key}`, value);
}

const gaugeValues = new Map<string, number>();

/** Render the registry in Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];

  for (const [name, metric] of registry) {
    if (name.endsWith("__gauge_holder")) continue;

    if (metric.kind === "counter") {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} counter`);
      if (metric.values.size === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [labels, value] of metric.values) {
          lines.push(`${name}{${labels}} ${value}`);
        }
      }
      continue;
    }

    lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} histogram`);
    for (const [labels, series] of metric.series) {
      metric.buckets.forEach((bound, index) => {
        const prefix = labels ? `${labels},` : "";
        lines.push(`${name}_bucket{${prefix}le="${bound}"} ${series.counts[index]}`);
      });
      const prefix = labels ? `${labels},` : "";
      lines.push(`${name}_bucket{${prefix}le="+Inf"} ${series.count}`);
      lines.push(`${name}_sum${labels ? `{${labels}}` : ""} ${series.sum}`);
      lines.push(`${name}_count${labels ? `{${labels}}` : ""} ${series.count}`);
    }
  }

  for (const [key, value] of gaugeValues) {
    const separator = key.indexOf("|");
    const name = key.slice(0, separator);
    const labels = key.slice(separator + 1);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Register every metric the application emits. Idempotent. */
export function registerMetrics(): void {
  defineCounter("http_requests_total", "HTTP requests by route, method and status class.");
  defineHistogram("http_request_duration_seconds", "HTTP request latency in seconds.");
  defineCounter("rate_limit_rejections_total", "Requests rejected by a rate limiter, by operation.");
  defineCounter("uploads_total", "Upload outcome counters by status.");
  defineCounter("upload_bytes_total", "Total bytes accepted through upload completion.");
  defineCounter("jobs_started_total", "Jobs claimed by the worker.");
  defineCounter("jobs_completed_total", "Jobs that finished successfully.");
  defineCounter("jobs_failed_total", "Jobs that reached terminal failure.");
  defineCounter("jobs_retried_total", "Jobs requeued after a retryable failure.");
  defineCounter("jobs_recovered_total", "Stale jobs recovered by lease expiry.");
  defineHistogram("job_duration_seconds", "Job execution duration in seconds.");
  defineHistogram("image_processing_duration_seconds", "Sharp processing duration in seconds.");
  defineHistogram("generation_duration_seconds", "End-to-end generation duration in seconds.");
  defineCounter("generation_created_total", "Generations created, by platform and format.");
  defineCounter("worker_errors_total", "Unexpected worker loop errors.");
}

/** Reset the registry. Test-only. */
export function resetMetrics(): void {
  registry.clear();
  gaugeValues.clear();
}
