import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKEND_TYPES, type BackendConfigEntry } from "./backends/types.ts";
import { log } from "./log.ts";
import { BROADCAST_INTERVAL_MS } from "./timing.ts";

export interface CcmonConfig {
  maxInactivityHours: number;
  host: string;
  port: number;
  /**
   * Interval between periodic rescans + broadcasts to clients, in ms.
   * `0` disables the periodic rescan entirely.
   */
  broadcastIntervalMs: number;
  backends: BackendConfigEntry[];
}

export const DEFAULT_CONFIG: CcmonConfig = {
  maxInactivityHours: 1,
  host: "127.0.0.1",
  port: 8080,
  broadcastIntervalMs: BROADCAST_INTERVAL_MS,
  backends: [
    { type: "claude", enabled: true },
    { type: "opencode", enabled: true },
  ],
};

/**
 * Loads config from CCMON_CONFIG env var path, or the XDG default location.
 * Returns DEFAULT_CONFIG when the optional config file is missing.
 * Partial configs are merged with defaults.
 */
export function loadConfig(configPath?: string): CcmonConfig {
  const path = configPath ?? resolveConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { ...DEFAULT_CONFIG };
    log.warn("Unable to read configuration; using defaults", error, { path });
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn("Invalid configuration JSON; using defaults", error, { path });
    return { ...DEFAULT_CONFIG };
  }

  if (!isCcmonConfig(parsed)) {
    log.warn("Configuration must be a JSON object; using defaults", undefined, {
      path,
    });
    return { ...DEFAULT_CONFIG };
  }

  return mergeWithDefaults(parsed);
}

/**
 * Returns a new config with the provided overrides applied, skipping undefined values.
 */
export function mergeCliOverrides(
  config: CcmonConfig,
  overrides: Partial<CcmonConfig>,
): CcmonConfig {
  return {
    maxInactivityHours:
      overrides.maxInactivityHours ?? config.maxInactivityHours,
    host: overrides.host ?? config.host,
    port: overrides.port ?? config.port,
    broadcastIntervalMs:
      overrides.broadcastIntervalMs ?? config.broadcastIntervalMs,
    backends: overrides.backends ?? config.backends,
  };
}

function resolveConfigPath(): string {
  const envPath = process.env.CCMON_CONFIG;
  if (envPath) return envPath;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome ?? join(homedir(), ".config");
  return join(base, "ccmon", "config.json");
}

function isValidBackendEntry(v: unknown): v is BackendConfigEntry {
  if (typeof v !== "object" || v === null) return false;
  const entry = v as Record<string, unknown>;
  if (
    typeof entry.type !== "string" ||
    !(BACKEND_TYPES as readonly string[]).includes(entry.type) ||
    typeof entry.enabled !== "boolean"
  ) {
    return false;
  }

  if (entry.type === "claude") return isOptionalPath(entry.projectsDir);

  return (
    isOptionalPath(entry.databasePath) &&
    isOptionalPath(entry.statusLogPath) &&
    isOptionalPositiveFiniteNumber(entry.pollIntervalMs) &&
    isOptionalPositiveFiniteNumber(entry.statusPollIntervalMs)
  );
}

// Accepts any non-null object; mergeWithDefaults does per-field type narrowing.
function isCcmonConfig(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Merges a partial config loaded from file with defaults.
 * File may contain only a subset of fields.
 * Numeric fields are range-checked: port must be an integer in 1..65535,
 * maxInactivityHours must be a positive finite number; invalid values fall
 * back to their defaults.
 */
function mergeWithDefaults(partial: Record<string, unknown>): CcmonConfig {
  const rawPort = partial.port;
  const port =
    typeof rawPort === "number" &&
    Number.isInteger(rawPort) &&
    rawPort >= 1 &&
    rawPort <= 65535
      ? rawPort
      : DEFAULT_CONFIG.port;

  const rawHours = partial.maxInactivityHours;
  const maxInactivityHours =
    typeof rawHours === "number" && Number.isFinite(rawHours) && rawHours > 0
      ? rawHours
      : DEFAULT_CONFIG.maxInactivityHours;

  const rawBroadcast = partial.broadcastIntervalMs;
  const broadcastIntervalMs =
    typeof rawBroadcast === "number" &&
    Number.isFinite(rawBroadcast) &&
    rawBroadcast >= 0
      ? rawBroadcast
      : DEFAULT_CONFIG.broadcastIntervalMs;

  return {
    maxInactivityHours,
    host: typeof partial.host === "string" ? partial.host : DEFAULT_CONFIG.host,
    port,
    broadcastIntervalMs,
    backends: mergeBackends(partial.backends),
  };
}

function mergeBackends(value: unknown): BackendConfigEntry[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.backends;
  const backends = value.filter(isValidBackendEntry);
  if (backends.length === value.length) return backends;

  log.warn("Ignoring invalid backend configuration entries", undefined, {
    invalidEntries: value.length - backends.length,
  });
  if (value.length > 0 && backends.length === 0) {
    log.warn("No valid backends configured; using defaults");
    return DEFAULT_CONFIG.backends;
  }
  return backends;
}

function isOptionalPath(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isOptionalPositiveFiniteNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value > 0)
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
