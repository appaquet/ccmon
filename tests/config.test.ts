import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, mergeCliOverrides, DEFAULT_CONFIG } from '../src/config';

const TMPDIR = Bun.env.TMPDIR || '/tmp';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMPDIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadConfig', () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-config');
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

  test('missing file: returns defaults', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent.json'));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('valid file with maxInactivityHours: 6 returns correct value', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: 6 }));

    const config = loadConfig(configPath);
    expect(config.maxInactivityHours).toBe(6);
  });

  test('invalid JSON: returns defaults', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, 'not valid json {{');

    const config = loadConfig(configPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('partial config (empty {}): returns defaults (fails type guard)', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, JSON.stringify({}));

    // Empty object fails the type guard (no maxInactivityHours)
    const config = loadConfig(configPath);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('CCMON_CONFIG env var overrides path', async () => {
    const configPath = join(tmpDir, 'custom-config.json');
    await writeFile(configPath, JSON.stringify({ maxInactivityHours: 9 }));
    process.env.CCMON_CONFIG = configPath;

    // Call without explicit path so it reads from env
    const config = loadConfig();
    expect(config.maxInactivityHours).toBe(9);
  });
});

describe('mergeCliOverrides', () => {
  test('overrides maxInactivityHours', () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, { maxInactivityHours: 1 });
    expect(result.maxInactivityHours).toBe(1);
  });

  test('empty overrides keeps config unchanged', () => {
    const base = { ...DEFAULT_CONFIG };
    const result = mergeCliOverrides(base, {});
    expect(result).toEqual(base);
  });
});
