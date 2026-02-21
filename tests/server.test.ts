import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server';

const TMPDIR = Bun.env.TMPDIR || '/tmp';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMPDIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('HTTP server', () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-server');
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('GET / returns HTML', async () => {
    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<html');
    expect(body).toContain('ccmon');
  });

  test('GET /api/state returns JSON array', async () => {
    const projDir = join(tmpDir, '-home-user-testproj');
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: 'srv-test',
      cwd: '/home/user/testproj',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, 'session.jsonl'), firstLine + '\n');

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/api/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const entry = body[0] as Record<string, unknown>;
    expect(entry.projectName).toBe('testproj');
  });

  test('GET /unknown returns 404', async () => {
    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('HTTP server with maxInactivityHours filter', () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-server-filter');
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('/api/state with near-zero maxInactivityHours filters out stale projects', async () => {
    const projDir = join(tmpDir, '-home-user-staleproj');
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: 'stale-test',
      cwd: '/home/user/staleproj',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, 'session.jsonl'), firstLine + '\n');

    // Write an old status so lastUpdated is well in the past
    const oldTime = new Date(Date.now() - 10 * 3600 * 1000).toISOString(); // 10 hours ago
    await writeFile(
      join(projDir, 'status.local.json'),
      JSON.stringify({
        state: 'stopped',
        timestamp: oldTime,
        session_id: 'stale-test',
        working_dir: '/home/user/staleproj',
      }),
    );

    // maxInactivityHours = 0.000001 → effectively filters everything older than ~3.6ms
    const srv = startServer({ port: 0, claudeDir: tmpDir, maxInactivityHours: 0.000001 });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test('WebSocket initial state with Infinity maxInactivityHours still includes projects', async () => {
    const projDir = join(tmpDir, '-home-user-infproj');
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: 'inf-test',
      cwd: '/home/user/infproj',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, 'session.jsonl'), firstLine + '\n');

    const srv = startServer({ port: 0, claudeDir: tmpDir, maxInactivityHours: Infinity });
    stop = srv.stop;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for initial state'));
      }, 3000);

      ws.onmessage = (event) => {
        clearTimeout(timeout);
        ws.close();
        resolve(event.data as string);
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });

    const parsed = JSON.parse(message) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry.projectName).toBe('infproj');
  });
});

describe('WebSocket server', () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir('ccmon-server-ws');
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('WebSocket client receives broadcast when status file changes', async () => {
    const projDir = join(tmpDir, '-home-user-broadcastproj');
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: 'broadcast-test',
      cwd: '/home/user/broadcastproj',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, 'session.jsonl'), firstLine + '\n');

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const messages: string[] = [];

    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.onmessage = (event) => {
      messages.push(event.data as string);
    };

    // Wait for initial state
    await Bun.sleep(300);

    await writeFile(
      join(projDir, 'status.local.json'),
      JSON.stringify({
        state: 'running',
        timestamp: new Date().toISOString(),
        session_id: 'broadcast-test',
        working_dir: '/home/user/broadcastproj',
      }),
    );

    // Wait for debounced watcher to fire and broadcast
    await Bun.sleep(400);

    ws.close();

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const first = JSON.parse(messages[0]) as unknown[];
    expect(Array.isArray(first)).toBe(true);
    const firstEntry = first.find((e) => (e as Record<string, unknown>).projectName === 'broadcastproj');
    expect(firstEntry).toBeDefined();

    const second = JSON.parse(messages[1]) as unknown[];
    expect(Array.isArray(second)).toBe(true);
    const secondEntry = second.find((e) => (e as Record<string, unknown>).projectName === 'broadcastproj');
    expect(secondEntry).toBeDefined();
  });

  test('WebSocket connect receives initial state as JSON array', async () => {
    const projDir = join(tmpDir, '-home-user-wsproj');
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: 'ws-test',
      cwd: '/home/user/wsproj',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, 'session.jsonl'), firstLine + '\n');

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for initial state'));
      }, 3000);

      ws.onmessage = (event) => {
        clearTimeout(timeout);
        ws.close();
        resolve(event.data as string);
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });

    const parsed = JSON.parse(message) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry.projectName).toBe('wsproj');
  });
});
