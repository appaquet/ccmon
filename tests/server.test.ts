import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../src/server";
import { _resetCachesForTesting } from "../src/sessions";

const TMPDIR = Bun.env.TMPDIR || "/tmp";

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    TMPDIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("HTTP server", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server");
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("GET / returns HTML", async () => {
    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("ccmon");
    expect(body).toContain('id="project-grid"');
    expect(body).toContain('id="status-bar"');
  });

  test("GET /api/state returns JSON array", async () => {
    const projDir = join(tmpDir, "-home-user-testproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "srv-test",
      cwd: "/home/user/testproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;
    await srv.ready;

    const res = await fetch(`http://localhost:${srv.port}/api/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const entry = body[0] as Record<string, unknown>;
    expect(entry.projectName).toBe("testproj");
  });

  test("GET /unknown returns 404", async () => {
    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;

    const res = await fetch(`http://localhost:${srv.port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("HTTP server with maxInactivityHours filter", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-filter");
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("/api/state with near-zero maxInactivityHours filters out stale projects", async () => {
    const projDir = join(tmpDir, "-home-user-staleproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "stale-test",
      cwd: "/home/user/staleproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    const jsonlPath = join(projDir, "session.jsonl");
    await writeFile(jsonlPath, `${firstLine}\n`);

    // Backdate the JSONL mtime so lastUpdated is well in the past. Under JSONL-primary
    // state detection, lastUpdated comes from the JSONL mtime rather than the status timestamp.
    const oldMtime = new Date(Date.now() - 10 * 3600 * 1000); // 10 hours ago
    utimesSync(jsonlPath, oldMtime, oldMtime);

    // maxInactivityHours = 1 → filters the 10-hour-old project
    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: 1,
    });
    stop = srv.stop;
    await srv.ready;

    const res = await fetch(`http://localhost:${srv.port}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test("WebSocket initial state with Infinity maxInactivityHours still includes projects", async () => {
    const projDir = join(tmpDir, "-home-user-infproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "inf-test",
      cwd: "/home/user/infproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: Infinity,
    });
    stop = srv.stop;
    await srv.ready;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for initial state"));
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

    const envelope = JSON.parse(message) as {
      hostname: string;
      projects: unknown[];
    };
    const parsed = envelope.projects;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry.projectName).toBe("infproj");
  });
});

describe("WebSocket server", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-ws");
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("WebSocket client receives broadcast when status file changes", async () => {
    const projDir = join(tmpDir, "-home-user-broadcastproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "broadcast-test",
      cwd: "/home/user/broadcastproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;
    await srv.ready;

    const messages: string[] = [];

    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.onmessage = (event) => {
      messages.push(event.data as string);
    };

    // Wait for initial state delivery
    await Bun.sleep(100);

    await writeFile(
      join(projDir, "ccmon-status.json"),
      JSON.stringify({
        state: "running",
        timestamp: new Date().toISOString(),
        session_id: "broadcast-test",
        working_dir: "/home/user/broadcastproj",
      }),
    );

    // Wait for debounced watcher to fire and broadcast
    await Bun.sleep(400);

    ws.close();

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const firstEnvelope = JSON.parse(messages[0]) as {
      hostname: string;
      projects: unknown[];
    };
    const first = firstEnvelope.projects;
    expect(Array.isArray(first)).toBe(true);
    const firstEntry = first.find(
      (e) => (e as Record<string, unknown>).projectName === "broadcastproj",
    );
    expect(firstEntry).toBeDefined();

    const secondEnvelope = JSON.parse(messages[1]) as {
      hostname: string;
      projects: unknown[];
    };
    const second = secondEnvelope.projects;
    expect(Array.isArray(second)).toBe(true);
    const secondEntry = second.find(
      (e) => (e as Record<string, unknown>).projectName === "broadcastproj",
    );
    expect(secondEntry).toBeDefined();
  });

  test("WebSocket connect receives initial state as JSON array", async () => {
    const projDir = join(tmpDir, "-home-user-wsproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "ws-test",
      cwd: "/home/user/wsproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;
    await srv.ready;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for initial state"));
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

    const envelope = JSON.parse(message) as {
      hostname: string;
      projects: unknown[];
    };
    const parsed = envelope.projects;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry.projectName).toBe("wsproj");
  });

  test("WebSocket message includes hostname field", async () => {
    const srv = startServer({ port: 0, claudeDir: tmpDir });
    stop = srv.stop;
    await srv.ready;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for initial state"));
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

    const envelope = JSON.parse(message) as Record<string, unknown>;
    expect(typeof envelope.hostname).toBe("string");
    expect((envelope.hostname as string).length).toBeGreaterThan(0);
  });
});

// ─── R31: server-side state map ───────────────────────────────────────────────

describe("server-side state map (R31)", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-r31");
    _resetCachesForTesting();
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("R31: new WS connection receives state from populated map (no rescan)", async () => {
    const projDir = join(tmpDir, "-home-user-r31proj");
    await mkdir(projDir, { recursive: true });
    const jsonlPath = join(projDir, "r31-session.jsonl");
    await writeFile(
      jsonlPath,
      `${JSON.stringify({
        sessionId: "r31-test",
        cwd: "/home/user/r31proj",
        timestamp: new Date().toISOString(),
      })}\n`,
    );

    // Use sessions-index.json to provide gitBranch
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: "r31-test",
            fullPath: jsonlPath,
            fileMtime: Date.now(),
            projectPath: "/home/user/r31proj",
            isSidechain: false,
            gitBranch: "feature",
          },
        ],
      }),
    );

    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: Infinity,
    });
    stop = srv.stop;
    await srv.ready;

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for WS initial state"));
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

    const envelope = JSON.parse(message) as {
      hostname: string;
      projects: unknown[];
    };
    const parsed = envelope.projects;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry.projectName).toBe("r31proj");
    expect(entry.gitBranch).toBe("feature");
  });

  test("R31: /api/state returns map contents without triggering rescan", async () => {
    const projDir = join(tmpDir, "-home-user-r31apiproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "r31-api-test",
      cwd: "/home/user/r31apiproj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: Infinity,
    });
    stop = srv.stop;
    await srv.ready;

    const res = await fetch(`http://localhost:${srv.port}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const entry = body[0] as Record<string, unknown>;
    expect(entry.projectName).toBe("r31apiproj");
  });
});

// ─── R61: periodic safety broadcast ──────────────────────────────────────────

describe("periodic safety broadcast (R61)", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-r61");
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("R61: periodic broadcast delivers state to connected WS client", async () => {
    const projDir = join(tmpDir, "-home-user-r61proj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "r61-test",
      cwd: "/home/user/r61proj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    // Use a short interval to avoid waiting 30 s in the test
    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: Infinity,
      broadcastIntervalMs: 100,
    });
    stop = srv.stop;
    await srv.ready;

    const messages: string[] = [];

    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.onmessage = (event) => {
      messages.push(event.data as string);
    };

    // Wait long enough for at least two interval fires (initial open + ≥1 periodic)
    await Bun.sleep(450);
    ws.close();

    // The open event sends one message; periodic interval should send at least one more
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Every message must contain the project
    for (const msg of messages) {
      const envelope = JSON.parse(msg) as {
        hostname: string;
        projects: unknown[];
      };
      const entry = envelope.projects.find(
        (e) => (e as Record<string, unknown>).projectName === "r61proj",
      );
      expect(entry).toBeDefined();
    }
  }, 5000);
});

// ─── R34: state propagation ───────────────────────────────────────────────────

describe("state propagation (R34)", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-r34");
    _resetCachesForTesting();
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("R34: state change propagates immediately to WebSocket clients", async () => {
    const projDir = join(tmpDir, "-home-user-r34proj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "r34-test",
      cwd: "/home/user/r34proj",
      gitBranch: "main",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    await writeFile(
      join(projDir, "ccmon-status.json"),
      JSON.stringify({
        state: "stopped",
        timestamp: new Date().toISOString(),
        session_id: "r34-test",
        working_dir: "/home/user/r34proj",
      }),
    );

    const srv = startServer({
      port: 0,
      claudeDir: tmpDir,
      maxInactivityHours: Infinity,
    });
    stop = srv.stop;
    await srv.ready;

    const messages: Array<unknown[]> = [];

    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.onmessage = (event) => {
      const envelope = JSON.parse(event.data as string) as {
        hostname: string;
        projects: unknown[];
      };
      messages.push(envelope.projects);
    };

    // Wait for initial state delivery
    await Bun.sleep(100);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Initial state should be stopped
    const initialEntry = messages[0]?.find(
      (e) => (e as Record<string, unknown>).projectName === "r34proj",
    ) as Record<string, unknown> | undefined;
    expect(initialEntry?.state).toBe("stopped");

    ws.close();
  });
});
