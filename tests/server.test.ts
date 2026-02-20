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
