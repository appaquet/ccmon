import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TMPDIR = Bun.env.TMPDIR || '/tmp';
const CLI_PATH = join(import.meta.dir, '..', 'src', 'cli.ts');

/**
 * Splits a string of concatenated pretty-printed JSON values into individual
 * JSON strings by tracking bracket/brace nesting depth.
 */
function splitJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMPDIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeFirstLine(cwd: string, sessionId: string): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), sessionId, cwd, gitBranch: 'main' });
}

function makeStatusPayload(state = 'running'): string {
  return JSON.stringify({
    state,
    timestamp: new Date().toISOString(),
    session_id: 'test-session',
    working_dir: '/home/user/proj',
  });
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnCli(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  });

  if (options.stdin === undefined) {
    // Close stdin immediately so the process doesn't block waiting for input
    // proc.stdin is a Bun FileSink when stdin is 'pipe'
    (proc.stdin as { end?: () => void } | null)?.end?.();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

// ─── dump ─────────────────────────────────────────────────────────────────────

describe('dump', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-dump');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('outputs JSON array of project states', async () => {
    const projDir = join(tmpDir, '-home-user-proj');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session.jsonl'), makeFirstLine('/home/user/proj', 'sid1') + '\n');

    const result = await spawnCli(['dump'], { env: { CLAUDE_PROJECTS_DIR: tmpDir } });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cwd).toBe('/home/user/proj');
  });
});

// ─── dump --project ───────────────────────────────────────────────────────────

describe('dump --project', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-dump-project');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('outputs single JSON object matching the given projectName', async () => {
    const projDir = join(tmpDir, '-home-user-myapp');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session.jsonl'), makeFirstLine('/home/user/myapp', 'sid1') + '\n');

    // Second project with a different name
    const proj2Dir = join(tmpDir, '-home-user-otherapp');
    await mkdir(proj2Dir, { recursive: true });
    await writeFile(join(proj2Dir, 'session.jsonl'), makeFirstLine('/home/user/otherapp', 'sid2') + '\n');

    const result = await spawnCli(['dump', '--project', 'myapp'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // Single object, not an array
    expect(Array.isArray(parsed)).toBe(false);
    expect(typeof parsed).toBe('object');
    expect(parsed.projectName).toBe('myapp');
    expect(parsed.cwd).toBe('/home/user/myapp');
  });

  test('outputs nothing when project name does not exist', async () => {
    const projDir = join(tmpDir, '-home-user-myapp');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session.jsonl'), makeFirstLine('/home/user/myapp', 'sid1') + '\n');

    const result = await spawnCli(['dump', '--project', 'nonexistent'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('--project with no value → non-zero exit with stderr message', async () => {
    const result = await spawnCli(['dump', '--project'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--project requires a value');
  });
});

// ─── dump --max-age ───────────────────────────────────────────────────────────

describe('dump --max-age', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-dump-maxage');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('--max-age with no value → non-zero exit with stderr message', async () => {
    const result = await spawnCli(['dump', '--max-age'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--max-age requires a valid number');
  });

  test('--max-age with non-numeric value → non-zero exit with stderr message', async () => {
    const result = await spawnCli(['dump', '--max-age', 'notanumber'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--max-age requires a valid number');
  });
});

// ─── dump --watch --project ────────────────────────────────────────────────────

describe('dump --watch --project', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-watch-project');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('initial output is a single JSON object for the given project', async () => {
    const projDir = join(tmpDir, '-home-user-watchapp');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/watchapp', 'sess-wp') + '\n',
    );

    const proc = Bun.spawn(['bun', 'run', CLI_PATH, 'dump', '--watch', '--project', 'watchapp'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    await Bun.sleep(300);
    proc.kill('SIGINT');

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(blocks[0]);
    // Single object, not array
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.projectName).toBe('watchapp');
    expect(parsed.cwd).toBe('/home/user/watchapp');
  }, 5000);

  test('each update is a single JSON object after status file changes', async () => {
    const projDir = join(tmpDir, '-home-user-watchapp2');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/watchapp2', 'sess-wp2') + '\n',
    );

    const proc = Bun.spawn(['bun', 'run', CLI_PATH, 'dump', '--watch', '--project', 'watchapp2'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    await Bun.sleep(300);

    // Trigger a status file change
    await writeFile(join(projDir, 'status.local.json'), makeStatusPayload('running'));
    await Bun.sleep(400);

    proc.kill('SIGINT');
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed.projectName).toBe('watchapp2');
    }
  }, 5000);
});

// ─── status ───────────────────────────────────────────────────────────────────

describe('status', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-status');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('pipe hook JSON → writes correct status.local.json', async () => {
    // Set up a project dir that scanProjects() will find
    const projDir = join(tmpDir, '-home-user-myproject');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/myproject', 'sess-abc') + '\n',
    );

    const hookPayload = JSON.stringify({
      session_id: 'sess-abc',
      cwd: '/home/user/myproject',
      hook_event_name: 'Stop',
    });

    const result = await spawnCli(['status'], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);

    const raw = await readFile(join(projDir, 'status.local.json'), 'utf8');
    const status = JSON.parse(raw);
    expect(status.state).toBe('stopped');
    expect(status.session_id).toBe('sess-abc');
    expect(status.working_dir).toBe('/home/user/myproject');
    expect(typeof status.timestamp).toBe('string');
  });

  test('outputs hook response JSON to stdout', async () => {
    const projDir = join(tmpDir, '-home-user-hookproj');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/hookproj', 'sess-hook') + '\n',
    );

    const hookPayload = JSON.stringify({
      session_id: 'sess-hook',
      cwd: '/home/user/hookproj',
      hook_event_name: 'PostToolUse',
    });

    const result = await spawnCli(['status'], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    // Hook protocol requires a JSON response on stdout
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe('object');
  });

  test('empty stdin → non-zero exit with stderr message', async () => {
    const result = await spawnCli(['status'], {
      stdin: '',
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test('invalid JSON stdin → non-zero exit with stderr message', async () => {
    const result = await spawnCli(['status'], {
      stdin: 'not valid json {{',
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test('empty cwd in hook JSON → non-zero exit with stderr message', async () => {
    const hookPayload = JSON.stringify({
      session_id: 'sess-emptycwd',
      cwd: '',
      hook_event_name: 'Stop',
    });

    const result = await spawnCli(['status'], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('cwd is empty');
  });

  test('cwd not matching any known project → falls back to encoded path', async () => {
    // No project dirs exist, so scanProjects() returns []. The fallback encodes cwd
    // as a directory name and creates it.
    const unknownCwd = '/tmp/unknown-project';

    const hookPayload = JSON.stringify({
      session_id: 'sess-unknown',
      cwd: unknownCwd,
      hook_event_name: 'Stop',
    });

    const result = await spawnCli(['status'], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Should succeed: fallback creates the dir and writes the status file
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe('object');
  });

  test('hook event mapped to all known states', async () => {
    // R35: UserPromptSubmit and PostToolUse no longer write state (removed hooks).
    // Only PermissionRequest, Stop, and SessionEnd produce written state.
    const events: Array<[string, string]> = [
      ['PermissionRequest', 'waiting_for_permission'],
      ['Stop', 'stopped'],
      ['SessionEnd', 'stopped'],
    ];

    for (const [eventName, expectedState] of events) {
      const projDir = join(tmpDir, `-home-user-${eventName.toLowerCase()}`);
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, 'session.jsonl'),
        makeFirstLine(`/home/user/${eventName.toLowerCase()}`, `sess-${eventName}`) + '\n',
      );

      const hookPayload = JSON.stringify({
        session_id: `sess-${eventName}`,
        cwd: `/home/user/${eventName.toLowerCase()}`,
        hook_event_name: eventName,
      });

      const result = await spawnCli(['status'], {
        stdin: hookPayload,
        env: { CLAUDE_PROJECTS_DIR: tmpDir },
      });

      expect(result.exitCode).toBe(0);
      const raw = await readFile(join(projDir, 'status.local.json'), 'utf8');
      const status = JSON.parse(raw);
      expect(status.state).toBe(expectedState);
    }
  });

  test('UserPromptSubmit and PostToolUse are no-ops (R35)', async () => {
    // These hooks no longer write state — ccmon status exits 0 with {} but no file written.
    for (const eventName of ['UserPromptSubmit', 'PostToolUse']) {
      const projDir = join(tmpDir, `-home-user-noop-${eventName.toLowerCase()}`);
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, 'session.jsonl'),
        makeFirstLine(`/home/user/noop-${eventName.toLowerCase()}`, `sess-noop-${eventName}`) + '\n',
      );

      const hookPayload = JSON.stringify({
        session_id: `sess-noop-${eventName}`,
        cwd: `/home/user/noop-${eventName.toLowerCase()}`,
        hook_event_name: eventName,
      });

      const result = await spawnCli(['status'], {
        stdin: hookPayload,
        env: { CLAUDE_PROJECTS_DIR: tmpDir },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(typeof parsed).toBe('object');
      // No status file should have been written
      try {
        await readFile(join(projDir, 'status.local.json'), 'utf8');
        throw new Error(`Expected no status file for ${eventName}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  });
});

// ─── dump --watch ─────────────────────────────────────────────────────────────

describe('dump --watch', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-watch');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('prints initial JSON state immediately on start', async () => {
    const projDir = join(tmpDir, '-home-user-watchproj');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/watchproj', 'sess-watch') + '\n',
    );

    // Start the watcher, wait briefly, then kill it
    const proc = Bun.spawn(['bun', 'run', CLI_PATH, 'dump', '--watch'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Give it time to print the initial state
    await Bun.sleep(300);
    proc.kill('SIGINT');

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // First output should be a valid JSON array
    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(blocks[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cwd).toBe('/home/user/watchproj');
  }, 5000);

  test('prints updated JSON when status file changes', async () => {
    const projDir = join(tmpDir, '-home-user-watchchange');
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, 'session.jsonl'),
      makeFirstLine('/home/user/watchchange', 'sess-change') + '\n',
    );

    const proc = Bun.spawn(['bun', 'run', CLI_PATH, 'dump', '--watch'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Wait for initial state to print
    await Bun.sleep(300);

    // Trigger a status file change
    await writeFile(join(projDir, 'status.local.json'), makeStatusPayload('running'));
    // Wait for watcher debounce + propagation
    await Bun.sleep(400);

    proc.kill('SIGINT');
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // No separator lines — output is consecutive JSON blocks
    expect(stdout).not.toContain('---');

    // Each block should be independently parseable JSON
    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      expect(Array.isArray(parsed)).toBe(true);
    }
  }, 5000);

  test('exits cleanly on SIGINT', async () => {
    const proc = Bun.spawn(['bun', 'run', CLI_PATH, 'dump', '--watch'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    await Bun.sleep(200);
    proc.kill('SIGINT');

    const exitCode = await proc.exited;
    // Clean exit: 0 or signal-terminated (130 for SIGINT, or null)
    expect(exitCode === 0 || exitCode === 130 || exitCode === null).toBe(true);
  }, 5000);
});

// ─── sub ──────────────────────────────────────────────────────────────────────

describe('sub', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-cli-sub');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('--port with no value → non-zero exit with stderr message (R17)', async () => {
    const result = await spawnCli(['sub', '--port'], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--port requires a valid number');
  });
});
