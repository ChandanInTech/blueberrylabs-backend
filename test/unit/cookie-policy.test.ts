import { afterEach, describe, expect, test } from "bun:test";
import { resetEnvCache } from "../../src/config/env";

const MANAGED = ["COOKIE_SAME_SITE", "COOKIE_SECURE", "NODE_ENV"] as const;
const ORIGINAL = new Map(MANAGED.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of MANAGED) {
    const value = ORIGINAL.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
});

function setEnv(overrides: Record<string, string>) {
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  resetEnvCache();
}

describe("cookie policy", () => {
  test("defaults to SameSite=Lax", async () => {
    delete process.env.COOKIE_SAME_SITE;
    resetEnvCache();
    const { getEnv } = await import("../../src/config/env");
    expect(getEnv().COOKIE_SAME_SITE).toBe("lax");
  });

  test("accepts SameSite=None for cross-site deployments", async () => {
    setEnv({ COOKIE_SAME_SITE: "none", COOKIE_SECURE: "true" });
    const { getEnv } = await import("../../src/config/env");
    expect(getEnv().COOKIE_SAME_SITE).toBe("none");
  });

  test("rejects an unknown SameSite value", async () => {
    setEnv({ COOKIE_SAME_SITE: "bogus" });
    const { getEnv } = await import("../../src/config/env");
    expect(() => getEnv()).toThrow();
  });

  test("documents why None needs Secure", async () => {
    // Browsers drop SameSite=None without Secure, so the pairing is enforced in
    // the auth routes rather than left to configuration.
    setEnv({ COOKIE_SAME_SITE: "none", COOKIE_SECURE: "false", NODE_ENV: "development" });
    const { getEnv } = await import("../../src/config/env");
    const env = getEnv();
    const secure =
      env.COOKIE_SECURE === "auto" ? env.NODE_ENV === "production" : env.COOKIE_SECURE === "true";
    expect(env.COOKIE_SAME_SITE).toBe("none");
    expect(secure).toBe(false);
  });
});
