import { readFileSync } from "node:fs";

/**
 * Restores process.env from /proc/self/environ when Bun fails to initialize
 * the environment inside sandbox environments (e.g., nono).
 *
 * Bun's process.env may be empty/denuded even though the OS environment is
 * intact — other runtimes (Node.js, Python, bash) read it correctly.
 *
 * See https://github.com/oven-sh/bun/issues/27802
 */
export function restoreProcessEnv(): void {
  if (process.platform !== "linux") return;
  // Bun injects ~3 non-enumerable keys (TZ, NODE_TLS_REJECT_UNAUTHORIZED, BUN_CONFIG_VERBOSE_FETCH).
  // A healthy environment has 50+ enumerable keys. Threshold of 10 avoids unnecessary /proc reads.
  if (Object.getOwnPropertyNames(process.env).length > 10) return;

  try {
    const raw = readFileSync("/proc/self/environ", "utf8");
    for (const entry of raw.split("\0").filter(Boolean)) {
      const eq = entry.indexOf("=");
      if (eq > 0) process.env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    // /proc/self/environ not readable — sandbox may block it
  }
}
