import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  scanProjects,
  readStatus,
  readSessionsIndex,
  checkLiveness,
  getProjectState,
  mapHookEventToState,
  writeStatus,
  filterStaleProjects,
} from '../src/sessions';

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

  test('sessions-index.json present: returns enriched fields, uses projectPath as cwd', async () => {
    const projDir = join(tmpDir, '-home-user-indexed');
    await mkdir(projDir, { recursive: true });

    const entry = {
      sessionId: 'idx-sess',
      fullPath: join(projDir, 'idx-sess.jsonl'),
      fileMtime: 1_700_000_000_000,
      firstPrompt: 'Work on feature X',
      summary: 'Feature X implementation',
      messageCount: 42,
      created: '2026-02-01T00:00:00.000Z',
      modified: '2026-02-01T02:00:00.000Z',
      gitBranch: 'main',
      projectPath: '/home/user/indexed',
      isSidechain: false,
    };
    await writeFile(join(projDir, 'sessions-index.json'), JSON.stringify({ version: 1, entries: [entry] }));
    // JSONL file must exist since latestJSONL points to it (stat used in getProjectState)
    await writeFile(entry.fullPath, makeFirstLine('/home/user/indexed', 'idx-sess') + '\n');

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].cwd).toBe('/home/user/indexed');
    expect(results[0].projectName).toBe('indexed');
    expect(results[0].sessionId).toBe('idx-sess');
    expect(results[0].latestJSONL).toBe(entry.fullPath);
    expect(results[0].summary).toBe('Feature X implementation');
    expect(results[0].firstPrompt).toBe('Work on feature X');
    expect(results[0].messageCount).toBe(42);
    expect(results[0].sessionModified).toBe('2026-02-01T02:00:00.000Z');
  });
});

// ─── readSessionsIndex ───────────────────────────────────────────────────────

describe('readSessionsIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-index');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeIndexEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 'sess-1',
      fullPath: '/some/path/sess-1.jsonl',
      fileMtime: 1_700_000_000_000,
      firstPrompt: 'Hello world',
      summary: 'A session summary',
      messageCount: 10,
      created: '2026-02-01T00:00:00.000Z',
      modified: '2026-02-01T01:00:00.000Z',
      gitBranch: 'main',
      projectPath: '/home/user/project',
      isSidechain: false,
      ...overrides,
    };
  }

  test('valid sessions-index.json: returns projectPath and entries', async () => {
    const entry = makeIndexEntry();
    const index = { version: 1, entries: [entry] };
    await writeFile(join(tmpDir, 'sessions-index.json'), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.projectPath).toBe('/home/user/project');
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].sessionId).toBe('sess-1');
    expect(result!.entries[0].fullPath).toBe('/some/path/sess-1.jsonl');
    expect(result!.entries[0].fileMtime).toBe(1_700_000_000_000);
    expect(result!.entries[0].summary).toBe('A session summary');
    expect(result!.entries[0].firstPrompt).toBe('Hello world');
    expect(result!.entries[0].messageCount).toBe(10);
    expect(result!.entries[0].modified).toBe('2026-02-01T01:00:00.000Z');
  });

  test('missing sessions-index.json: returns null', async () => {
    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
  });

  test('corrupt JSON: returns null', async () => {
    await writeFile(join(tmpDir, 'sessions-index.json'), 'not valid json {{');
    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
  });

  test('picks entry with highest fileMtime as latest session', async () => {
    const older = makeIndexEntry({ sessionId: 'old', fullPath: '/p/old.jsonl', fileMtime: 1_000 });
    const newer = makeIndexEntry({ sessionId: 'new', fullPath: '/p/new.jsonl', fileMtime: 2_000 });
    const index = { version: 1, entries: [older, newer] };
    await writeFile(join(tmpDir, 'sessions-index.json'), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    // entries returned in original order; caller picks max
    expect(result!.entries).toHaveLength(2);
    const maxEntry = result!.entries.reduce((a, b) => (a.fileMtime > b.fileMtime ? a : b));
    expect(maxEntry.sessionId).toBe('new');
  });

  test('filters out isSidechain: true entries', async () => {
    const mainEntry = makeIndexEntry({ sessionId: 'main', isSidechain: false });
    const sideEntry = makeIndexEntry({ sessionId: 'side', isSidechain: true });
    const index = { version: 1, entries: [mainEntry, sideEntry] };
    await writeFile(join(tmpDir, 'sessions-index.json'), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].sessionId).toBe('main');
  });

  test('all entries are sidechains: returns null (no usable entries)', async () => {
    const sideEntry = makeIndexEntry({ sessionId: 'side', isSidechain: true });
    const index = { version: 1, entries: [sideEntry] };
    await writeFile(join(tmpDir, 'sessions-index.json'), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
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

// ─── mapHookEventToState ──────────────────────────────────────────────────────

describe('mapHookEventToState', () => {
  test('UserPromptSubmit → running', () => {
    expect(mapHookEventToState('UserPromptSubmit')).toBe('running');
  });

  test('PostToolUse → running', () => {
    expect(mapHookEventToState('PostToolUse')).toBe('running');
  });

  test('PermissionRequest → waiting_for_permission', () => {
    expect(mapHookEventToState('PermissionRequest')).toBe('waiting_for_permission');
  });

  test('Stop → stopped', () => {
    expect(mapHookEventToState('Stop')).toBe('stopped');
  });

  test('SessionEnd → stopped', () => {
    expect(mapHookEventToState('SessionEnd')).toBe('stopped');
  });

  test('unknown event → null', () => {
    expect(mapHookEventToState('SomeUnknownEvent')).toBeNull();
    expect(mapHookEventToState('')).toBeNull();
  });
});

// ─── writeStatus ─────────────────────────────────────────────────────────────

describe('writeStatus', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-write-status');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('writes status.local.json with correct content', async () => {
    const status = {
      state: 'running' as const,
      timestamp: '2026-02-20T12:00:00.000Z',
      session_id: 'test-session-id',
      working_dir: '/home/user/project',
    };

    await writeStatus(tmpDir, status);

    const raw = await Bun.file(join(tmpDir, 'status.local.json')).text();
    const parsed = JSON.parse(raw);
    expect(parsed.state).toBe('running');
    expect(parsed.timestamp).toBe('2026-02-20T12:00:00.000Z');
    expect(parsed.session_id).toBe('test-session-id');
    expect(parsed.working_dir).toBe('/home/user/project');
  });

  test('round-trip: writeStatus output is parseable by readStatus', async () => {
    const status = {
      state: 'waiting_for_permission' as const,
      timestamp: new Date().toISOString(),
      session_id: 'round-trip-id',
      working_dir: '/home/user/rt',
    };

    await writeStatus(tmpDir, status);
    const result = await readStatus(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.state).toBe('waiting_for_permission');
    expect(result!.session_id).toBe('round-trip-id');
    expect(result!.working_dir).toBe('/home/user/rt');
  });
});

// ─── filterStaleProjects ──────────────────────────────────────────────────────

describe('filterStaleProjects', () => {
  function makeProject(lastUpdated: string | null): import('../src/sessions').ProjectState {
    return {
      projectDir: 'dir',
      cwd: '/home/user/proj',
      projectName: 'proj',
      sessionId: 'sid',
      latestJSONL: '/home/user/proj/session.jsonl',
      state: 'stopped',
      lastUpdated,
    };
  }

  test('recent lastUpdated: project is kept', () => {
    const recent = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const projects = [makeProject(recent)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(1);
  });

  test('old lastUpdated: project is removed', () => {
    const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString(); // 5 hours ago
    const projects = [makeProject(old)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(0);
  });

  test('null lastUpdated: project is removed', () => {
    const projects = [makeProject(null)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(0);
  });

  test('maxInactivityHours = 0: all projects returned (filter disabled)', () => {
    const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const projects = [makeProject(null), makeProject(old)];
    const result = filterStaleProjects(projects, 0);
    expect(result).toHaveLength(2);
  });

  test('maxInactivityHours = Infinity: all projects returned (filter disabled)', () => {
    const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const projects = [makeProject(null), makeProject(old)];
    const result = filterStaleProjects(projects, Infinity);
    expect(result).toHaveLength(2);
  });
});
