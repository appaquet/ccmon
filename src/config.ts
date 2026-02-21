import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CcmonConfig {
  maxInactivityHours: number;
}

export const DEFAULT_CONFIG: CcmonConfig = {
  maxInactivityHours: 3,
};

/**
 * Loads config from CCMON_CONFIG env var path, or the XDG default location.
 * Returns DEFAULT_CONFIG silently on missing file, invalid JSON, or invalid shape.
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

  return parsed;
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
  return result;
}

function resolveConfigPath(): string {
  const envPath = process.env.CCMON_CONFIG;
  if (envPath) return envPath;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome ?? join(process.env.HOME ?? '/root', '.config');
  return join(base, 'ccmon', 'config.json');
}

function isCcmonConfig(v: unknown): v is CcmonConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.maxInactivityHours === 'number';
}
