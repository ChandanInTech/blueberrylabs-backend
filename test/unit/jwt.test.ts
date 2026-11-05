import { describe, expect, test } from "bun:test";
import { signAccessToken, verifyAccessToken } from "../../src/modules/auth/jwt";

const SECRET = "a".repeat(48);
const OTHER_SECRET = "b".repeat(48);

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("JWT signing", () => {
  test("round-trips the claims it was given", () => {
    const { token, expiresAt } = signAccessToken({ sub: "user-1", jti: "session-1" }, SECRET, 3600);

    const claims = verifyAccessToken(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.jti).toBe("session-1");
    expect(claims!.exp).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  test("expiresAt matches the requested TTL", () => {
    const before = Math.floor(Date.now() / 1000);
    const { expiresAt } = signAccessToken({ sub: "u", jti: "s" }, SECRET, 24 * 3600);
    const after = Math.floor(Date.now() / 1000);

    const exp = Math.floor(expiresAt.getTime() / 1000);
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3600);
    expect(exp).toBeLessThanOrEqual(after + 24 * 3600);
  });

  test("uses HS256 in the header", () => {
    const { token } = signAccessToken({ sub: "u", jti: "s" }, SECRET, 60);
    expect(decodePart(token.split(".")[0]!)).toEqual({ alg: "HS256", typ: "JWT" });
  });
});

describe("JWT verification", () => {
  test("rejects a token signed with a different secret", () => {
    const { token } = signAccessToken({ sub: "u", jti: "s" }, OTHER_SECRET, 3600);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  test("rejects a tampered payload", () => {
    const { token } = signAccessToken({ sub: "user-1", jti: "session-1" }, SECRET, 3600);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", jti: "session-1", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");

    expect(verifyAccessToken(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  test("rejects an expired token", () => {
    // TTL of 0 puts exp at the current second, which is already expired.
    const { token } = signAccessToken({ sub: "u", jti: "s" }, SECRET, 0);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  test("rejects the alg:none downgrade", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u", jti: "s", iat: 0, exp: 9_999_999_999 })).toString(
      "base64url",
    );

    expect(verifyAccessToken(`${header}.${payload}.`, SECRET)).toBeNull();
    expect(verifyAccessToken(`${header}.${payload}`, SECRET)).toBeNull();
  });

  test("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "not.a.jwt", "..", "a.b.c"]) {
      expect(verifyAccessToken(bad, SECRET)).toBeNull();
    }
  });

  test("rejects a token missing required claims", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u", exp: 9_999_999_999 })).toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");

    // Correctly signed, but no `jti` — must still be refused.
    expect(verifyAccessToken(`${header}.${payload}.${signature}`, SECRET)).toBeNull();
  });
});
