import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CcmonConfig {
  maxInactivityHours: number;
  host: string;
  port: number;
}

export const DEFAULT_CONFIG: CcmonConfig = {
  maxInactivityHours: 3,
  host: '0.0.0.0',
  port: 9480,
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
    raw = readFileSync(path, 'utf8');
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
  const result = { ...config };
  if (overrides.maxInactivityHours !== undefined) {
    result.maxInactivityHours = overrides.maxInactivityHours;
  }
  if (overrides.host !== undefined) {
    result.host = overrides.host;
  }
  if (overrides.port !== undefined) {
    result.port = overrides.port;
  }
  return result;
}

function resolveConfigPath(): string {
  const envPath = process.env.CCMON_CONFIG;
  if (envPath) return envPath;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome ?? join(process.env.HOME ?? '/root', '.config');
  return join(base, 'ccmon', 'config.json');
}

// REVIEW: code-style-reviewer - `isCcmonConfig` is declared as `v is CcmonConfig` but only validates `maxInactivityHours`. `CcmonConfig` requires `host: string` and `port: number` as well, so this type predicate overpromises — TypeScript treats the result as a fully-valid `CcmonConfig` even when `host`/`port` are absent, causing `mergeWithDefaults` to need the defensive casts. The return type should be `v is Partial<CcmonConfig>` (or a dedicated `RawConfig` type) to accurately reflect what is validated.
// REVIEW: architecture-reviewer - The type-guard/merge split is an architectural inconsistency: `isCcmonConfig` asserts `v is CcmonConfig` (fully valid) but intentionally leaves validation partial, forcing `mergeWithDefaults` to defensively re-check fields it already trusts due to the type assertion. The correct design is a two-step approach: a guard returning `v is { maxInactivityHours: number }` (minimum validity), then `mergeWithDefaults` accepting `unknown` or `Partial<CcmonConfig>` and applying defaults without needing casts. This removes the false type guarantee and the redundant defensive checks, and makes the boundary between "valid enough to proceed" and "fully defaults-merged" explicit.
function isCcmonConfig(v: unknown): v is CcmonConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  // Requires at least maxInactivityHours to be valid; other fields optional and merged with defaults
  return typeof obj.maxInactivityHours === 'number';
}

/**
 * Merges a partial config loaded from file with defaults.
 * File may contain only a subset of fields.
 */
// REVIEW: code-style-reviewer - `partial` is typed as `CcmonConfig` but `host` and `port` are immediately cast to `Record<string, unknown>` to perform type checks that the TypeScript type already guarantees. This is a mismatch: if `partial` can actually be a partial config with missing fields, the parameter type should be `Partial<CcmonConfig>` (which `isCcmonConfig` validates is not fully guaranteed for `host`/`port`). The casts make the code harder to read and should be replaced by a cleaner approach — either change the parameter type to `Partial<CcmonConfig>` and use `partial.host ?? DEFAULT_CONFIG.host`, or update `isCcmonConfig` to validate all fields and trust the type here.
function mergeWithDefaults(partial: CcmonConfig): CcmonConfig {
  return {
    maxInactivityHours: partial.maxInactivityHours ?? DEFAULT_CONFIG.maxInactivityHours,
    host: typeof (partial as Record<string, unknown>).host === 'string' ? (partial as Record<string, unknown>).host as string : DEFAULT_CONFIG.host,
    port: typeof (partial as Record<string, unknown>).port === 'number' ? (partial as Record<string, unknown>).port as number : DEFAULT_CONFIG.port,
  };
}
