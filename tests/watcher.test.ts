import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { watchForChanges } from '../src/watcher';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TMPDIR = Bun.env.TMPDIR || '/tmp';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMPDIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeStatusPayload(): string {
  return JSON.stringify({
    state: 'running',
    timestamp: new Date().toISOString(),
    session_id: 'test-session',
    working_dir: '/home/user/proj',
  });
}

// ─── watchForChanges ─────────────────────────────────────────────────────────

describe('watchForChanges', () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-watch');
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('returns a stop() function that can be called without error', async () => {
    const watcher = watchForChanges(tmpDir, () => { });
    expect(typeof watcher.stop).toBe('function');
    // Should not throw
    watcher.stop();
    stop = null; // already stopped, skip afterEach cleanup
  }, 3000);

  test('file change to status.local.json triggers onUpdate callback', async () => {
    const projDir = join(tmpDir, '-home-user-proj');
    await mkdir(projDir, { recursive: true });
    const statusFile = join(projDir, 'status.local.json');
    await writeFile(statusFile, makeStatusPayload());

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    // Write to the status file to trigger a change
    await Bun.sleep(50); // Let watcher settle
    await writeFile(statusFile, makeStatusPayload());
    await Bun.sleep(200); // Let fs events propagate + debounce

    expect(called.length).toBeGreaterThan(0);
    expect(called[0]).toBe(projDir);
  }, 3000);

  test('JSONL file write triggers onUpdate callback', async () => {
    const projDir = join(tmpDir, '-home-user-jsonlproj');
    await mkdir(projDir, { recursive: true });

    // Pre-create the JSONL so the project dir exists before watcher init
    const jsonlFile = join(projDir, 'session.jsonl');
    await writeFile(jsonlFile, '{"type":"user"}\n');

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    await Bun.sleep(50); // Let watcher settle

    // Simulate Claude appending a new line to the session JSONL
    await writeFile(jsonlFile, '{"type":"user"}\n{"type":"assistant"}\n');
    await Bun.sleep(200); // Let fs events propagate + debounce

    expect(called.length).toBeGreaterThan(0);
    expect(called[0]).toBe(projDir);
  }, 3000);

  test('debounce: multiple rapid writes produce a single callback', async () => {
    const projDir = join(tmpDir, '-home-user-debounce');
    await mkdir(projDir, { recursive: true });
    const statusFile = join(projDir, 'status.local.json');
    await writeFile(statusFile, makeStatusPayload());

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    await Bun.sleep(50); // Let watcher settle

    // Rapid writes within the debounce window (simulates Claude's frequent JSONL writes)
    for (let i = 0; i < 5; i++) {
      await writeFile(statusFile, makeStatusPayload());
    }

    await Bun.sleep(300); // Wait for debounce window + propagation

    expect(called.length).toBe(1);
  }, 3000);
});
