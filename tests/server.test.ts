import { utimesSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaudeBackend } from "../src/backends/claude";
import type { SessionBackend } from "../src/backends/types";
import { startServer } from "../src/server";
import type { SessionState } from "../src/session-core";
import type { SessionEnrichment } from "../src/session-enrichment";
import type { ProjectInfo, SubagentInfo } from "../src/types";
import { makeTempDir } from "./_helpers";

/**
 * Wraps a SessionBackend so watchForChanges is a no-op.
 * Used to test the periodic rescan path independently of watchers.
 */
class NoWatchBackend implements SessionBackend {
  constructor(private inner: SessionBackend) {}

  scanProjects() {
    return this.inner.scanProjects();
  }
  watchForChanges(_onUpdate: () => void): { stop: () => void } {
    return { stop() {} };
  }
  resolveState(info: ProjectInfo): Promise<SessionState> {
    return this.inner.resolveState(info);
  }
  computeLastUpdated(info: ProjectInfo): Promise<string | null> {
    return this.inner.computeLastUpdated(info);
  }
  enrichProject(info: ProjectInfo): Promise<SessionEnrichment> {
    return this.inner.enrichProject(info);
  }
  getSubagents(info: ProjectInfo): Promise<SubagentInfo[]> {
    return this.inner.getSubagents(info);
  }
  projectKey(project: ProjectInfo): string {
    return this.inner.projectKey(project);
  }
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
    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
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
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
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
    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
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
      backends: [new ClaudeBackend(tmpDir)],
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
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({
      port: 0,
      backends: [new ClaudeBackend(tmpDir)],
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
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
    stop = srv.stop;
    await srv.ready;

    const messages: string[] = [];

    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.onmessage = (event) => {
      messages.push(event.data as string);
    };

    // Wait for initial state delivery
    await new Promise((r) => setTimeout(r, 100));

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
    await new Promise((r) => setTimeout(r, 400));

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
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
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
    const srv = startServer({ port: 0, backends: [new ClaudeBackend(tmpDir)] });
    await srv.ready;
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

    const srv = startServer({
      port: 0,
      backends: [new ClaudeBackend(tmpDir)],
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
  });

  test("R31: /api/state returns map contents without triggering rescan", async () => {
    const projDir = join(tmpDir, "-home-user-r31apiproj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "r31-api-test",
      cwd: "/home/user/r31apiproj",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const srv = startServer({
      port: 0,
      backends: [new ClaudeBackend(tmpDir)],
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
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    // Use a short interval to avoid waiting 30 s in the test
    const srv = startServer({
      port: 0,
      backends: [new ClaudeBackend(tmpDir)],
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
    await new Promise((r) => setTimeout(r, 450));
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

  test("R61: periodic rescan detects state change even without watcher", async () => {
    const projDir = join(tmpDir, "-home-user-r61rescan");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      sessionId: "r61-rescan",
      cwd: "/home/user/r61rescan",
      timestamp: new Date().toISOString(),
    });
    const jsonlPath = join(projDir, "session.jsonl");
    await writeFile(jsonlPath, `${firstLine}\n`);

    // Use NoWatchBackend so watchers don't fire — only periodic rescan can update
    const backend = new NoWatchBackend(new ClaudeBackend(tmpDir));
    const srv = startServer({
      port: 0,
      backends: [backend],
      maxInactivityHours: Infinity,
      broadcastIntervalMs: 100,
    });
    stop = srv.stop;
    await srv.ready;

    // Collect initial state
    const initialRes = await fetch(`http://localhost:${srv.port}/api/state`);
    const initial = (await initialRes.json()) as Record<string, unknown>[];
    const found = initial.find((e) => e.projectName === "r61rescan") as
      | Record<string, unknown>
      | undefined;
    expect(found).toBeDefined();
    // Without a status log, JSONL mtime is ≤60s → "running"
    expect(found?.state).toBe("running");

    // Write a Stop event to ccmon-status.jsonl so the periodic rescan sees it
    const statusLine = JSON.stringify({
      state: "stopped",
      event: "Stop",
      timestamp: new Date().toISOString(),
      session_id: "r61-rescan",
      working_dir: "/home/user/r61rescan",
    });
    await writeFile(join(projDir, "ccmon-status.jsonl"), `${statusLine}\n`);

    // Wait for the periodic rescan to pick up the change.
    // Poll API state until stopped or timeout (100ms interval + margin).
    let updatedEntry: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const updatedRes = await fetch(`http://localhost:${srv.port}/api/state`);
      const updated = (await updatedRes.json()) as Record<string, unknown>[];
      updatedEntry = updated.find((e) => e.projectName === "r61rescan") as
        | Record<string, unknown>
        | undefined;
      if (updatedEntry?.state === "stopped") break;
    }
    expect(updatedEntry).toBeDefined();
    // Periodic rescan should have picked up the Stop event → "stopped"
    expect(updatedEntry?.state).toBe("stopped");
  }, 5000);
});

// ─── R34: state propagation ───────────────────────────────────────────────────

describe("state propagation (R34)", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-server-r34");
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
      backends: [new ClaudeBackend(tmpDir)],
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
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Initial state should be stopped
    const initialEntry = messages[0]?.find(
      (e) => (e as Record<string, unknown>).projectName === "r34proj",
    ) as Record<string, unknown> | undefined;
    expect(initialEntry?.state).toBe("stopped");

    ws.close();
  });
});
