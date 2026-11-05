/** Random URL-safe token, 32 bytes of entropy by default. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("base64url");
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Stable, stable-across-restarts instance identifier used for job leases. */
export function instanceId(): string {
  const override = process.env.INSTANCE_ID?.trim();
  if (override) return override;
  return `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${process.pid}:${uuid().slice(0, 8)}`;
}
