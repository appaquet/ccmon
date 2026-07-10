import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeCliOverrides,
} from "../src/config.ts";
import { makeTempDir } from "./_helpers.ts";

describe("loadConfig", () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-config");
    originalEnv.CCMON_CONFIG = process.env.CCMON_CONFIG;
    originalEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    delete process.env.CCMON_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    // Restore env vars
    if (originalEnv.CCMON_CONFIG === undefined) {
      delete process.env.CCMON_CONFIG;
    } else {
      process.env.CCMON_CONFIG = originalEnv.CCMON_CONFIG;
    }
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
  });

  test("missing file: returns defaults", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.json"));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("defaults to a loopback host", () => {
    expect(DEFAULT_CONFIG.host).toBe("127.0.0.1");
  });

  test("valid file with maxInactivityHours: 6 returns correct value", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ maxInactivityHours: 6, host: "0.0.0.0", port: 8080 }),
    );

    const config = loadConfig(configPath);
    expect(config.maxInactivityHours).toBe(6);
  });

  test("valid file with host and port returns correct values", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ maxInactivityHours: 3, host: "127.0.0.1", port: 8080 }),
    );

    const config = loadConfig(configPath);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
  });

  test("invalid JSON: returns defaults", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, "not valid json {{");

    const config = loadConfig(configPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("malformed configuration emits a structured diagnostic", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, "not valid json {{");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
      expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
        level: "warn",
        msg: "Invalid configuration JSON; using defaults",
        fields: { path: configPath },
      });
    } finally {
      stderr.mockRestore();
    }
  });

  test("unreadable configuration emits a structured diagnostic", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      expect(loadConfig(tmpDir)).toEqual(DEFAULT_CONFIG);
      expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
        level: "warn",
        msg: "Unable to read configuration; using defaults",
        fields: { path: tmpDir },
      });
    } finally {
      stderr.mockRestore();
    }
  });

  test("partial config with only host and port merges with defaults", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ host: "127.0.0.1", port: 8080 }),
    );

    const config = loadConfig(configPath);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.maxInactivityHours).toBe(DEFAULT_CONFIG.maxInactivityHours);
  });

  test("partial config with invalid field types: falls back to defaults per field", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ maxInactivityHours: "bad", port: "notanumber" }),
    );

    const config = loadConfig(configPath);
    expect(config.maxInactivityHours).toBe(DEFAULT_CONFIG.maxInactivityHours);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
  });

  test("port -1 falls back to default", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ port: -1 }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
  });

  test("port 70000 falls back to default", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ port: 70000 }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
  });

  test("port 3.5 (non-integer) falls back to default", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ port: 3.5 }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
  });

  test("maxInactivityHours -1 falls back to default", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: -1 }));

    const config = loadConfig(configPath);
    expect(config.maxInactivityHours).toBe(DEFAULT_CONFIG.maxInactivityHours);
  });

  test("maxInactivityHours 0 falls back to default", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: 0 }));

    const config = loadConfig(configPath);
    expect(config.maxInactivityHours).toBe(DEFAULT_CONFIG.maxInactivityHours);
  });

  test("port 1 and port 65535 are accepted as boundary values", async () => {
    const configPath = join(tmpDir, "config.json");

    await writeFile(configPath, JSON.stringify({ port: 1 }));
    expect(loadConfig(configPath).port).toBe(1);

    await writeFile(configPath, JSON.stringify({ port: 65535 }));
    expect(loadConfig(configPath).port).toBe(65535);
  });

  test("partial config (empty {}): returns defaults", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({}));

    const config = loadConfig(configPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("CCMON_CONFIG env var overrides path", async () => {
    const configPath = join(tmpDir, "custom-config.json");
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: 9 }));
    process.env.CCMON_CONFIG = configPath;

    // Call without explicit path so it reads from env
    const config = loadConfig();
    expect(config.maxInactivityHours).toBe(9);
  });
});

describe("mergeCliOverrides", () => {
  test("overrides maxInactivityHours", () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, { maxInactivityHours: 1 });
    expect(result.maxInactivityHours).toBe(1);
  });

  test("overrides host", () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, { host: "127.0.0.1" });
    expect(result.host).toBe("127.0.0.1");
  });

  test("overrides port", () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, { port: 8080 });
    expect(result.port).toBe(8080);
  });

  test("empty overrides keeps config unchanged", () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, {});
    expect(result).toEqual(base);
  });
});

describe("backends config", () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-config-backends");
    originalEnv.CCMON_CONFIG = process.env.CCMON_CONFIG;
    originalEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    delete process.env.CCMON_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalEnv.CCMON_CONFIG === undefined) {
      delete process.env.CCMON_CONFIG;
    } else {
      process.env.CCMON_CONFIG = originalEnv.CCMON_CONFIG;
    }
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
  });

  test("backends config: claude enabled parses correctly", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [{ type: "claude", enabled: true }],
      }),
    );

    const config = loadConfig(configPath);
    expect(config.backends).toHaveLength(1);
    expect(config.backends[0].type).toBe("claude");
    expect(config.backends[0].enabled).toBe(true);
  });

  test("backends config: opencode enabled parses correctly", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [{ type: "opencode", enabled: true }],
      }),
    );

    const config = loadConfig(configPath);
    expect(config.backends).toHaveLength(1);
    expect(config.backends[0].type).toBe("opencode");
    expect(config.backends[0].enabled).toBe(true);
  });

  test("absent backends field: defaults to both backends", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: 3 }));

    const config = loadConfig(configPath);
    expect(config.backends).toHaveLength(2);
    expect(config.backends[0].type).toBe("claude");
    expect(config.backends[0].enabled).toBe(true);
    expect(config.backends[1].type).toBe("opencode");
    expect(config.backends[1].enabled).toBe(true);
  });

  test("disabled backend still present in parsed config", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [
          { type: "claude", enabled: false },
          { type: "opencode", enabled: true },
        ],
      }),
    );

    const config = loadConfig(configPath);
    expect(config.backends).toHaveLength(2);
    expect(config.backends.find((b) => b.type === "claude")?.enabled).toBe(
      false,
    );
    expect(config.backends.find((b) => b.type === "opencode")?.enabled).toBe(
      true,
    );
  });

  test("invalid backend-specific values are rejected", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [
          { type: "claude", enabled: true, projectsDir: 42 },
          { type: "opencode", enabled: true, pollIntervalMs: 0 },
        ],
      }),
    );

    expect(loadConfig(configPath).backends).toEqual(DEFAULT_CONFIG.backends);
  });

  test("retains valid entries when another configured backend is invalid", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [
          { type: "claude", enabled: true },
          { type: "opencode", enabled: true, databasePath: "" },
        ],
      }),
    );

    expect(loadConfig(configPath).backends).toEqual([
      { type: "claude", enabled: true },
    ]);
  });
});
