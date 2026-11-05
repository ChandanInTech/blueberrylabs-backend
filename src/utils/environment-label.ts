import { getEnv } from "../config/env";

export function getEnvironmentLabel(): string {
  try {
    return getEnv().NODE_ENV;
  } catch {
    return process.env.NODE_ENV ?? "unknown";
  }
}
