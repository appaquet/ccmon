import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKEND_TYPES, type BackendConfigEntry } from "./backends/types.ts";

export interface CcmonConfig {
  maxInactivityHours: number;
  host: string;
  port: number;
  backends: BackendConfigEntry[];
}

export const DEFAULT_CONFIG: CcmonConfig = {
  maxInactivityHours: 1,
  host: "0.0.0.0",
  port: 8080,
  backends: [
    { type: "claude", enabled: true },
    { type: "opencode", enabled: true },
  ],
};

/**
 * Loads config from CCMON_CONFIG env var path, or the XDG default location.
 * Returns DEFAULT_CONFIG silently on missing file, invalid JSON, or invalid shape.
 * Partial configs are merged with defaults.
 */
export function loadConfig(configPath?: string): CcmonConfig {
  const path = configPath ?? resolveConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  if (!isCcmonConfig(parsed)) return { ...DEFAULT_CONFIG };

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
  return (
    typeof entry.type === "string" &&
    (BACKEND_TYPES as readonly string[]).includes(entry.type) &&
    typeof entry.enabled === "boolean"
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

  return {
    maxInactivityHours,
    host: typeof partial.host === "string" ? partial.host : DEFAULT_CONFIG.host,
    port,
    backends: Array.isArray(partial.backends)
      ? partial.backends.filter(isValidBackendEntry)
      : DEFAULT_CONFIG.backends,
  };
}
