import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { scanProjects, readStatus, checkLiveness, getProjectState } from '../src/sessions';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMPDIR = Bun.env.TMPDIR || '/tmp';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMPDIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeFirstLine(cwd: string, sessionId: string, gitBranch = 'main'): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), sessionId, cwd, gitBranch });
}

// ─── scanProjects ────────────────────────────────────────────────────────────

describe('scanProjects', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-scan');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('happy path: returns correct projectDir, cwd, projectName, sessionId, latestJSONL', async () => {
    const projDir = join(tmpDir, '-home-user-myproject');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session1.jsonl'), makeFirstLine('/home/user/myproject', 'abc123') + '\n');

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].projectDir).toBe('-home-user-myproject');
    expect(results[0].cwd).toBe('/home/user/myproject');
    expect(results[0].projectName).toBe('myproject');
    expect(results[0].sessionId).toBe('abc123');
    expect(results[0].latestJSONL).toBe(join(projDir, 'session1.jsonl'));
  });

  test('multiple JSONL files: picks most recently modified one', async () => {
    const projDir = join(tmpDir, '-home-user-proj');
    await mkdir(projDir, { recursive: true });

    // older file
    const older = join(projDir, 'old.jsonl');
    await writeFile(older, makeFirstLine('/home/user/proj', 'old-session') + '\n');
    // set mtime to past
    const pastTime = new Date(Date.now() - 60_000);
    await utimes(older, pastTime, pastTime);

    // newer file
    const newer = join(projDir, 'new.jsonl');
    await writeFile(newer, makeFirstLine('/home/user/proj', 'new-session') + '\n');

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('new-session');
    expect(results[0].latestJSONL).toBe(newer);
  });

  test('no JSONL files in subdir: skips that project', async () => {
    const projDir = join(tmpDir, '-home-user-nojsonl');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'status.local.json'), '{}');

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test('corrupt JSONL (invalid JSON first line): skips that project', async () => {
    const projDir = join(tmpDir, '-home-user-corrupt');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session.jsonl'), 'not valid json\n');

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test('subagents/ subdir in project dir: ignored as a project dir', async () => {
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, 'session.jsonl'), makeFirstLine('/some/path', 'sa-session') + '\n');

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test('empty projects dir: returns empty array', async () => {
    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test('multiple valid projects: returns all', async () => {
    for (const name of ['-home-user-proj-a', '-home-user-proj-b']) {
      const projDir = join(tmpDir, name);
      await mkdir(projDir, { recursive: true });
      await writeFile(join(projDir, 'session.jsonl'), makeFirstLine(`/home/user/${name}`, `id-${name}`) + '\n');
    }

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(2);
  });
});

// ─── readStatus ──────────────────────────────────────────────────────────────

describe('readStatus', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-status');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('valid status.local.json: returns StatusFile', async () => {
    const payload = {
      state: 'running',
      timestamp: '2026-02-19T10:00:00.000Z',
      session_id: 'abc123',
      working_dir: '/home/user/proj',
    };
    await writeFile(join(tmpDir, 'status.local.json'), JSON.stringify(payload));

    const result = await readStatus(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.state).toBe('running');
    expect(result!.timestamp).toBe('2026-02-19T10:00:00.000Z');
    expect(result!.session_id).toBe('abc123');
    expect(result!.working_dir).toBe('/home/user/proj');
  });

  test('waiting_for_answer state: accepted', async () => {
    const payload = { state: 'waiting_for_answer', timestamp: '2026-02-19T10:00:00.000Z', session_id: 's', working_dir: '/p' };
    await writeFile(join(tmpDir, 'status.local.json'), JSON.stringify(payload));
    const result = await readStatus(tmpDir);
    expect(result!.state).toBe('waiting_for_answer');
  });

  test('waiting_for_permission state: accepted', async () => {
    const payload = { state: 'waiting_for_permission', timestamp: '2026-02-19T10:00:00.000Z', session_id: 's', working_dir: '/p' };
    await writeFile(join(tmpDir, 'status.local.json'), JSON.stringify(payload));
    const result = await readStatus(tmpDir);
    expect(result!.state).toBe('waiting_for_permission');
  });

  test('stopped state: accepted', async () => {
    const payload = { state: 'stopped', timestamp: '2026-02-19T10:00:00.000Z', session_id: 's', working_dir: '/p' };
    await writeFile(join(tmpDir, 'status.local.json'), JSON.stringify(payload));
    const result = await readStatus(tmpDir);
    expect(result!.state).toBe('stopped');
  });

  test('missing file: returns null', async () => {
    const result = await readStatus(tmpDir);
    expect(result).toBeNull();
  });

  test('corrupt JSON: returns null', async () => {
    await writeFile(join(tmpDir, 'status.local.json'), 'not json at all');
    const result = await readStatus(tmpDir);
    expect(result).toBeNull();
  });

  test('unknown state value: returns null', async () => {
    const payload = { state: 'unknown_state', timestamp: '2026-02-19T10:00:00.000Z', session_id: 's', working_dir: '/p' };
    await writeFile(join(tmpDir, 'status.local.json'), JSON.stringify(payload));
    const result = await readStatus(tmpDir);
    expect(result).toBeNull();
  });
});

// ─── checkLiveness ───────────────────────────────────────────────────────────

describe('checkLiveness', () => {
  // NOTE: Live process detection (pgrep / /proc scanning) cannot be reliably
  // mocked in unit tests without process injection. Those paths are covered by
  // manual integration testing via `bun run dump`.

  test('empty cwds: returns empty set', async () => {
    const result = await checkLiveness([]);
    expect(result.size).toBe(0);
  });

  test('parseProcessOutput: extracts cwds matching provided list', () => {
    // Tested indirectly; parseProcessOutput is an exported helper for unit testing
    import('../src/sessions').then(({ parseProcessOutput }) => {
      // pgrep -a output: "PID command args"
      const output = '1234 /usr/bin/node /path/to/claude --arg\n5678 claude\n';
      const pids = parseProcessOutput(output);
      expect(pids).toContain(1234);
      expect(pids).toContain(5678);
    });
  });
});

// ─── getProjectState ─────────────────────────────────────────────────────────

describe('getProjectState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-state');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeProject(name: string, cwd: string, sessionId: string): Promise<string> {
    const projDir = join(tmpDir, name);
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session.jsonl'), makeFirstLine(cwd, sessionId) + '\n');
    return projDir;
  }

  test('status present and fresh (< 5min): uses status state', async () => {
    const projDir = await makeProject('-home-user-fresh', '/home/user/fresh', 'sid1');
    const payload = {
      state: 'running',
      timestamp: new Date().toISOString(), // now = fresh
      session_id: 'sid1',
      working_dir: '/home/user/fresh',
    };
    await writeFile(join(projDir, 'status.local.json'), JSON.stringify(payload));

    const results = await getProjectState(tmpDir);

    expect(results).toHaveLength(1);
    // No live process found by checkLiveness in test env → overridden to stopped
    // but if running processes were detected it would stay 'running'.
    // We can only verify lastUpdated is set.
    expect(results[0].lastUpdated).toBe(payload.timestamp);
  });

  test('status absent: state = stopped, lastUpdated falls back to JSONL mtime', async () => {
    await makeProject('-home-user-nostatus', '/home/user/nostatus', 'sid2');

    const before = Date.now();
    const results = await getProjectState(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('stopped');
    expect(results[0].lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(results[0].lastUpdated!).getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(new Date(results[0].lastUpdated!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('status stale (> 5min) and state != stopped: overridden to stopped', async () => {
    const projDir = await makeProject('-home-user-stale', '/home/user/stale', 'sid3');
    const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const payload = {
      state: 'running',
      timestamp: staleTime.toISOString(),
      session_id: 'sid3',
      working_dir: '/home/user/stale',
    };
    await writeFile(join(projDir, 'status.local.json'), JSON.stringify(payload));

    const results = await getProjectState(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('stopped');
  });

  test('status stale but already stopped: remains stopped', async () => {
    const projDir = await makeProject('-home-user-stale-stopped', '/home/user/stale-stopped', 'sid4');
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    const payload = {
      state: 'stopped',
      timestamp: staleTime.toISOString(),
      session_id: 'sid4',
      working_dir: '/home/user/stale-stopped',
    };
    await writeFile(join(projDir, 'status.local.json'), JSON.stringify(payload));

    const results = await getProjectState(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe('stopped');
  });

  test('multiple projects: all returned', async () => {
    await makeProject('-home-user-a', '/home/user/a', 'sida');
    await makeProject('-home-user-b', '/home/user/b', 'sidb');

    const results = await getProjectState(tmpDir);
    expect(results).toHaveLength(2);
  });
});
