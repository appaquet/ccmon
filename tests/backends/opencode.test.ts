import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildProjectState } from "../../src/backends/build-project-state.ts";
import { OpencodeBackend } from "../../src/backends/opencode.ts";
import { filterStaleProjects } from "../../src/project-utils.ts";
import type { SessionState } from "../../src/session-core.ts";
import {
  OPENCODE_ACTIVE_THRESHOLD_MS,
  PERMISSION_STALE_MS,
  STATUS_LOG_TAIL_BYTES,
  SUBAGENT_EXPIRY_MS,
  SUBAGENT_LIFECYCLE_TIMEOUT_MS,
} from "../../src/timing.ts";

type DB = DatabaseSync;

function run(
  db: DB,
  sql: string,
  params: (string | number | null)[] = [],
): void {
  db.prepare(sql).run(...params);
}

function createSchema(db: DB): void {
  run(
    db,
    `
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      name TEXT,
      root TEXT
    )
  `,
  );
  run(
    db,
    `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER,
      parent_id TEXT,
      project_id TEXT REFERENCES project(id)
    )
  `,
  );
  run(db, "CREATE INDEX session_parent_id_idx ON session(parent_id)");
  run(
    db,
    `
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `,
  );
  run(
    db,
    `
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `,
  );
  run(
    db,
    `
    CREATE TABLE todo (
      session_id TEXT,
      content TEXT,
      status TEXT,
      priority TEXT,
      position INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    )
  `,
  );
}

describe("OpencodeBackend — core", () => {
  let db: DB;
  let backend: OpencodeBackend;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    backend = new OpencodeBackend(db);
  });

  test("projectKey returns stable unique string per project", () => {
    const project = {
      projectDir: "any",
      cwd: "/home/user/myproject",
      projectName: "myproject",
      sessionId: "ses_abc123",
      source: "opencode" as const,
    };
    const key = backend.projectKey(project);
    expect(typeof key).toBe("string");
    expect(key).toContain("opencode::");
    expect(key).toContain("ses_abc123");
    // Same project = same key
    expect(backend.projectKey(project)).toBe(key);
  });

  test("requires a session.parent_id index for recursive traversal", () => {
    const unindexedDb = new DatabaseSync(":memory:");
    run(unindexedDb, "CREATE TABLE session (id TEXT, parent_id TEXT)");

    expect(() => new OpencodeBackend(unindexedDb)).toThrow(
      "requires an index on parent_id",
    );
  });

  test("scanProjects returns only active sessions (time_archived IS NULL, parent_id IS NULL)", async () => {
    const now = Date.now();
    const projId = "project-1";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "myproject",
      "/home/user/myproject",
    ]);

    // Active session
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_active",
        "Active Session",
        "/home/user/myproject",
        now - 60000,
        now,
        projId,
      ],
    );
    // Stale session (time_updated 5 min ago)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_stale",
        "Stale Session",
        "/home/user/stale",
        now - 60000,
        now - 300000,
        projId,
      ],
    );
    // Archived session
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_archived",
        "Archived",
        "/home/user/old",
        now - 60000,
        now,
        now,
        projId,
      ],
    );
    // Sub-agent session (parent_id IS NOT NULL)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child",
        "Sub-agent",
        "/home/user/myproject",
        now - 60000,
        now,
        "ses_active",
        projId,
      ],
    );

    const projects = await backend.scanProjects();

    expect(projects).toHaveLength(2); // active + stale (both non-archived, non-child)
    expect(projects.find((p) => p.sessionId === "ses_active")).toBeDefined();
    expect(projects.find((p) => p.sessionId === "ses_stale")).toBeDefined();
    expect(
      projects.find((p) => p.sessionId === "ses_archived"),
    ).toBeUndefined();
    expect(projects.find((p) => p.sessionId === "ses_child")).toBeUndefined();
  });

  test("scanProjects extracts project.name, session.directory as cwd, session.id", async () => {
    const now = Date.now();
    const projId = "proj-2";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "testproj",
      "/home/user/testproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_001",
        "Test Session",
        "/home/user/testproj",
        now - 60000,
        now,
        projId,
      ],
    );

    const projects = await backend.scanProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].projectName).toBe("testproj");
    expect(projects[0].cwd).toBe("/home/user/testproj");
    expect(projects[0].sessionId).toBe("ses_001");
    expect(projects[0].source).toBe("opencode");
  });

  test("scanProjects returns empty array when no sessions exist", async () => {
    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(0);
  });

  test("falls back to graph-only collection when the message table is absent", async () => {
    const now = Date.now();
    run(db, "DROP TABLE message");
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-no-messages",
      "no-messages",
      "/home/user/no-messages",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_no_messages",
        "No messages",
        "/home/user/no-messages",
        now - 1_000,
        now,
        "proj-no-messages",
      ],
    );

    const projects = await backend.scanProjects();

    expect(projects.map((project) => project.sessionId)).toEqual([
      "ses_no_messages",
    ]);
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
  });

  test("scanProjects falls back to basename(cwd) when project.name is null", async () => {
    const now = Date.now();
    const projId = "proj-noname";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, NULL, ?)", [
      projId,
      "/home/user/fallbackproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_noname",
        "No Name Project",
        "/home/user/fallbackproj",
        now - 60000,
        now,
        projId,
      ],
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].projectName).toBe("fallbackproj");
    expect(projects[0].source).toBe("opencode");
  });

  test("scanProjects returns all top-level sessions in the same directory ordered by recency", async () => {
    const now = Date.now();
    const projId = "proj-dedup";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "dedupproj",
      "/home/user/dedupproj",
    ]);

    // Newest session (now)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_new", "Newer", "/home/user/dedupproj", now - 60000, now, projId],
    );
    // Older session in same directory (60s ago)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_old",
        "Older",
        "/home/user/dedupproj",
        now - 120000,
        now - 60000,
        projId,
      ],
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.sessionId)).toEqual([
      "ses_new",
      "ses_old",
    ]);
  });

  test("scanProjects returns one session per directory when multiple directories exist", async () => {
    const now = Date.now();
    const projId = "proj-multidir";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "multidir",
      "/home/user/multidir",
    ]);

    // Dir A: two sessions, newest = ses_a2
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_a1", "A1", "/home/user/dir-a", now - 120000, now - 60000, projId],
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_a2", "A2", "/home/user/dir-a", now - 60000, now, projId],
    );
    // Dir B: one session
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_b", "B", "/home/user/dir-b", now - 60000, now - 30000, projId],
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(3);
    const ids = projects.map((p) => p.sessionId);
    expect(ids).toContain("ses_a2");
    expect(ids).toContain("ses_a1");
    expect(ids).toContain("ses_b");
  });

  test("scanProjects keeps parent_id children hidden even when same-directory siblings are visible", async () => {
    const now = Date.now();
    const projId = "proj-peer-boundary";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "peerboundary",
      "/home/user/peerboundary",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_parent_a",
        "Parent A",
        "/home/user/peerboundary",
        now - 120000,
        now - 2000,
        projId,
      ],
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_parent_b",
        "Parent B",
        "/home/user/peerboundary",
        now - 60000,
        now - 1000,
        projId,
      ],
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_hidden",
        "Child",
        "/home/user/peerboundary",
        now - 50000,
        now,
        "ses_parent_a",
        projId,
      ],
    );

    const projects = await backend.scanProjects();

    expect(projects.map((project) => project.sessionId)).toEqual([
      "ses_parent_b",
      "ses_parent_a",
    ]);
  });

  test("resolveState returns running when time_updated < 30s ago", async () => {
    const now = Date.now();
    const projId = "proj-state";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "stateproj",
      "/home/user/stateproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_run", "Running", "/home/user/stateproj", now - 60000, now, projId],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("running");
  });

  test("resolveState returns stopped when time_updated > 30s ago", async () => {
    const now = Date.now();
    const projId = "proj-stopped";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "oldproj",
      "/home/user/oldproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_stopped",
        "Old",
        "/home/user/oldproj",
        now - 120000,
        now - 120000,
        projId,
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("stopped");
  });

  test("buildProjectState assembles full ProjectState with source opencode", async () => {
    const now = Date.now();
    const projId = "proj-full";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "fullproj",
      "/home/user/fullproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_full",
        "Full Session",
        "/home/user/fullproj",
        now - 60000,
        now,
        projId,
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);

    expect(state.source).toBe("opencode");
    expect(state.state).toBe("running");
    expect(state.projectName).toBe("fullproj");
    expect(state.sessionId).toBe("ses_full");
    expect(state.lastUpdated).toBeDefined();
    // No enrichment yet (added in Task 3)
    expect(state.subagents).toBeUndefined();
    expect(state.subagentCount).toBeUndefined();
  });

  test("buildProjectState for stale session returns stopped", async () => {
    const now = Date.now();
    const projId = "proj-stale-full";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "staleproj",
      "/home/user/staleproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_stale_full",
        "Stale",
        "/home/user/staleproj",
        now - 120000,
        now - 120000,
        projId,
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);
    expect(state.state).toBe("stopped");
  });
});

describe("OpencodeBackend — SQLite activity fallback", () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-sqlite-activity-"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function insertRoot(sessionId: string, timeUpdated = now - 5 * 60_000): void {
    run(db, "INSERT OR IGNORE INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-sqlite-activity",
      "sqliteactivity",
      "/home/user/sqliteactivity",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        "SQLite activity",
        "/home/user/sqliteactivity",
        now - 10 * 60_000,
        timeUpdated,
        "proj-sqlite-activity",
      ],
    );
  }

  function insertPart(
    sessionId: string,
    partId: string,
    timeUpdated: number,
    data: Record<string, unknown>,
  ): void {
    const messageId = `message-${partId}`;
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        messageId,
        sessionId,
        now - 10 * 60_000,
        timeUpdated,
        JSON.stringify({ role: "assistant" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        partId,
        messageId,
        sessionId,
        now - 10 * 60_000,
        timeUpdated,
        JSON.stringify(data),
      ],
    );
  }

  function backendForStatus(records = ""): OpencodeBackend {
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    if (records) writeFileSync(statusPath, records);
    return new OpencodeBackend(db, 5_000, statusPath);
  }

  function statusRecord(
    sessionId: string,
    event: string,
    state: SessionState,
    timestamp: number,
  ): string {
    return `${JSON.stringify({
      event,
      state,
      timestamp: new Date(timestamp).toISOString(),
      session_id: sessionId,
      working_dir: "/home/user/sqliteactivity",
    })}\n`;
  }

  test("keeps the captured stale session running from fresh same-session streaming activity", async () => {
    insertRoot("captured");
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        "message-captured",
        "captured",
        now - 10 * 60_000,
        now - 20_000,
        JSON.stringify({ role: "assistant" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-captured",
        "message-captured",
        "captured",
        now - 10 * 60_000,
        now - 10_000,
        JSON.stringify({ type: "tool", tool: "apply_patch", state: "pending" }),
      ],
    );
    // A fresh heartbeat marks the plugin healthy; the session's last plugin
    // event is stale, so it still gets windowed SQLite inference.
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date(now - 5_000).toISOString(),
        active_sessions: 0,
      })}\n` +
        statusRecord(
          "captured",
          "question.replied",
          "running",
          now - 5 * 60_000,
        ),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(now - 10_000).toISOString(),
    );
  });

  test("keeps fresh message activity when the older schema has no part table", async () => {
    insertRoot("message-only");
    run(db, "DROP TABLE part");
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        "message-only-activity",
        "message-only",
        now - 10 * 60_000,
        now - 10_000,
        JSON.stringify({ role: "assistant" }),
      ],
    );
    // No plugin events at all, so the plugin is unhealthy and every visible
    // session gets windowed SQLite inference.
    const backend = backendForStatus();
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(now - 10_000).toISOString(),
    );
  });

  test("rechecks a part table created during the missing-table fallback", async () => {
    insertRoot("part-race");
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        "message-part-race",
        "part-race",
        now - 10 * 60_000,
        now - 5 * 60_000,
        JSON.stringify({ role: "assistant" }),
      ],
    );
    run(db, "DROP TABLE part");
    // A fresh heartbeat keeps inference enabled for sessions lacking plugin
    // evidence; without it the CTEs would be skipped entirely.
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date(now - 5_000).toISOString(),
        active_sessions: 0,
      })}\n`,
    );
    const originalPrepare = db.prepare.bind(db);
    let createdPartTable = false;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (
        !createdPartTable &&
        sql.includes("WITH RECURSIVE forest") &&
        sql.includes("FROM part p")
      ) {
        try {
          return originalPrepare(sql);
        } catch (error) {
          originalPrepare(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
          ).run();
          createdPartTable = true;
          throw error;
        }
      }
      return originalPrepare(sql);
    });

    try {
      const firstProject = (await backend.scanProjects())[0];
      await expect(backend.resolveState(firstProject)).resolves.toBe("stopped");
      run(
        db,
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "part-race-activity",
          "message-part-race",
          "part-race",
          now - 10_000,
          now - 10_000,
          JSON.stringify({ type: "text", text: "fresh" }),
        ],
      );
      const secondProject = (await backend.scanProjects())[0];

      await expect(backend.resolveState(secondProject)).resolves.toBe(
        "running",
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });

  test("accepts only valid activity strictly inside the 30-second threshold", async () => {
    insertRoot("fresh");
    insertPart("fresh", "part-fresh", now - OPENCODE_ACTIVE_THRESHOLD_MS + 1, {
      type: "tool",
      tool: "write",
      status: "running",
    });
    insertRoot("threshold");
    insertPart(
      "threshold",
      "part-threshold",
      now - OPENCODE_ACTIVE_THRESHOLD_MS,
      {
        type: "text",
        text: "at threshold",
      },
    );
    insertRoot("future");
    insertPart("future", "part-future", now + 1, {
      type: "text",
      text: "from the future",
    });
    // A fresh heartbeat keeps inference enabled for these sessions.
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date(now - 5_000).toISOString(),
        active_sessions: 0,
      })}\n`,
    );
    const projects = await backend.scanProjects();
    const fresh = projects.find((project) => project.sessionId === "fresh");
    const threshold = projects.find(
      (project) => project.sessionId === "threshold",
    );
    const future = projects.find((project) => project.sessionId === "future");
    if (!fresh || !threshold || !future) {
      throw new Error("expected all SQLite activity fixtures to be scanned");
    }

    await expect(backend.resolveState(fresh)).resolves.toBe("running");
    await expect(backend.resolveState(threshold)).resolves.toBe("stopped");
    await expect(backend.resolveState(future)).resolves.toBe("stopped");
  });

  test("expires a lone busy status record at the activity threshold", async () => {
    insertRoot("stale-busy");
    const backend = backendForStatus(
      statusRecord(
        "stale-busy",
        "session.status",
        "running",
        now - OPENCODE_ACTIVE_THRESHOLD_MS,
      ),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
  });

  test("does not let SQLite activity override explicit terminal or archived sessions", async () => {
    insertRoot("idle");
    insertPart("idle", "part-idle", now - 1_000, {
      type: "text",
      text: "active",
    });
    insertRoot("errored");
    insertPart("errored", "part-error", now - 1_000, {
      type: "text",
      text: "active",
    });
    insertRoot("closed");
    insertPart("closed", "part-closed", now - 1_000, {
      type: "text",
      text: "active",
    });
    insertRoot("archived", now - 1_000);
    run(db, "UPDATE session SET time_archived = ? WHERE id = ?", [
      now,
      "archived",
    ]);
    // A fresh heartbeat keeps inference enabled so the stale parts are visible.
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date(now - 5_000).toISOString(),
        active_sessions: 0,
      })}\n` +
        statusRecord("idle", "session.idle", "stopped", now - 2_000) +
        statusRecord("errored", "session.error", "error", now - 2_000) +
        statusRecord("closed", "session.deleted", "closed", now - 2_000),
    );
    const projects = await backend.scanProjects();
    const idle = projects.find((project) => project.sessionId === "idle");
    const errored = projects.find((project) => project.sessionId === "errored");
    const closed = projects.find((project) => project.sessionId === "closed");
    if (!idle || !errored || !closed) {
      throw new Error("expected all terminal fixtures to be scanned");
    }

    await expect(backend.resolveState(idle)).resolves.toBe("stopped");
    await expect(backend.resolveState(errored)).resolves.toBe("error");
    await expect(backend.resolveState(closed)).resolves.toBe("closed");
    expect(
      projects.find((project) => project.sessionId === "archived"),
    ).toBeUndefined();
  });
});

describe("OpencodeBackend — enrichment", () => {
  let db: DB;
  let backend: OpencodeBackend;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    backend = new OpencodeBackend(db);
  });

  function setupSession(): string {
    const now = Date.now();
    const projId = "proj-enrich";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "enrichproj",
      "/home/user/enrichproj",
    ]);
    const sessionId = "ses_enrich";
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        "Enrich Session",
        "/home/user/enrichproj",
        now - 60000,
        now,
        projId,
      ],
    );
    return sessionId;
  }

  function makeMsgData(fields: Record<string, unknown>): string {
    return JSON.stringify(fields);
  }

  function makePartData(fields: Record<string, unknown>): string {
    return JSON.stringify(fields);
  }

  test("extracts model from most recent assistant message data JSON", async () => {
    const sessionId = setupSession();
    const msgId = "msg-assistant";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makeMsgData({
          role: "assistant",
          modelID: "claude-sonnet-4-6",
          tokens: { input: 500, output: 200 },
        }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBe("claude-sonnet-4-6");
    expect(enrichment.inputTokens).toBe(500);
    expect(enrichment.outputTokens).toBe(200);
  });

  test("extracts latestUserActivity from most recent user message parts", async () => {
    const sessionId = setupSession();
    const msgId = "msg-user";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makeMsgData({ role: "user" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-text",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makePartData({ type: "text", text: "What is the weather today?" }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.latestUserActivity?.text).toBe(
      "What is the weather today?",
    );
    expect(enrichment.latestUserActivity?.isCommand).toBe(false);
  });

  test("extracts latestAssistantActivity from most recent assistant parts (tool via 'tool' field)", async () => {
    const sessionId = setupSession();
    const msgId = "msg-asst";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makeMsgData({ role: "assistant", modelID: "claude-haiku" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-text",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makePartData({ type: "text", text: "The current weather is sunny." }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-tool",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        makePartData({ type: "tool", tool: "Read" }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.latestAssistantActivity?.text).toBe(
      "The current weather is sunny.",
    );
    expect(enrichment.latestAssistantActivity?.tool).toBe("Read");
  });

  test("extracts sessionName from session.title", async () => {
    const _sessionId = setupSession();

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.sessionName).toBe("Enrich Session");
  });

  test("handles empty message history gracefully", async () => {
    const _sessionId = setupSession();

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBeUndefined();
    expect(enrichment.latestUserActivity).toBeUndefined();
  });

  test("handles corrupt/unparseable JSON in data column gracefully", async () => {
    const sessionId = setupSession();
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        "msg-bad",
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        "not valid json {{{",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBeUndefined();
  });

  test("buildProjectState includes enrichment fields", async () => {
    const sessionId = setupSession();
    const msgId = "msg-asst-full";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now(),
        Date.now(),
        makeMsgData({
          role: "assistant",
          modelID: "claude-opus",
          tokens: { input: 100, output: 50 },
        }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);

    expect(state.model).toBe("claude-opus");
    expect(state.inputTokens).toBe(100);
    expect(state.outputTokens).toBe(50);
    expect(state.sessionName).toBe("Enrich Session");
  });

  test("extract model and tokens using cache.read + input for cumulative input tokens", async () => {
    const sessionId = setupSession();
    const msgId = "msg-cached";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now(),
        Date.now(),
        makeMsgData({
          role: "assistant",
          modelID: "claude-opus",
          tokens: { input: 250, output: 100, cache: { read: 50000, write: 0 } },
        }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBe("claude-opus");
    expect(enrichment.inputTokens).toBe(50250);
    expect(enrichment.outputTokens).toBe(100);
  });
});

describe("OpencodeBackend — sub-agents", () => {
  let db: DB;
  let backend: OpencodeBackend;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    backend = new OpencodeBackend(db);
  });

  function setupParent(): string {
    const now = Date.now();
    const projId = "proj-parent";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "parentproj",
      "/home/user/parentproj",
    ]);
    const sessionId = "ses_parent";
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionId, "Parent", "/home/user/parentproj", now - 120000, now, projId],
    );
    return sessionId;
  }

  test("getSubagents queries session WHERE parent_id = ?", async () => {
    const now = Date.now();
    const parentId = setupParent();

    // Active child (time_updated = now → isActive = true)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_active",
        "Active Child",
        "/home/user/parentproj",
        now - 10000,
        now,
        parentId,
        "proj-parent",
      ],
    );
    // Quiet child remains active while no terminal event has been observed.
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_stale",
        "Stale Child",
        "/home/user/parentproj",
        now - 20000,
        now - 20000,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(subagents).toHaveLength(2);
    const active = subagents.find((s) => s.agentId === "ses_child_active");
    const stale = subagents.find((s) => s.agentId === "ses_child_stale");
    expect(active?.isActive).toBe(true);
    expect(stale?.isActive).toBe(true);
  });

  test("getSubagents fields: agentId, launchTime (ISO 8601), lastMessageTime (ISO 8601)", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const created = now - 30000;
    const updated = now;

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_ts",
        "Child TS",
        "/home/user/parentproj",
        created,
        updated,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].agentId).toBe("ses_child_ts");
    expect(subagents[0].launchTime).toBe(new Date(created).toISOString());
    expect(subagents[0].lastMessageTime).toBe(new Date(updated).toISOString());
  });

  test("getSubagents propagates child session title as sessionName without formatting", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const title = "Investigate subagent naming (@senior-dev subagent)";

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_named",
        title,
        "/home/user/parentproj",
        now - 30000,
        now,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].sessionName).toBe(title);
  });

  test("getSubagents leaves sessionName undefined when child title is missing", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_unnamed",
        null,
        "/home/user/parentproj",
        now - 30000,
        now,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].sessionName).toBeUndefined();
  });

  test("excludes linked sub-agents beyond lifecycle fallback timeout", async () => {
    const now = Date.now();
    const parentId = setupParent();

    const expired = now - SUBAGENT_LIFECYCLE_TIMEOUT_MS - 1_000;
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_expired",
        "Expired",
        "/home/user/parentproj",
        expired,
        expired,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(
      subagents.find((s) => s.agentId === "ses_child_expired"),
    ).toBeUndefined();
  });

  test("buildProjectState includes sub-agents when state is running", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_build",
        "Build Child",
        "/home/user/parentproj",
        now - 10000,
        now,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);

    expect(state.subagents).toBeDefined();
    expect(state.subagents?.length).toBe(1);
    expect(state.subagentCount).toBe(1);
  });

  test("quiet linked sub-agent older than old expiry window remains visible and active", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const quietTime = now - 120_000;

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_quiet_linked_child",
        "Quiet linked child",
        "/home/user/parentproj",
        quietTime,
        quietTime,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const subagents = await backend.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].agentId).toBe("ses_quiet_linked_child");
    expect(subagents[0].isActive).toBe(true);
  });

  test.each([
    ["session.idle", "stopped"],
    ["session.error", "error"],
  ])("quiet linked sub-agent remains briefly visible as inactive after %s", async (event, state) => {
    const now = Date.now();
    const parentId = setupParent();
    const quietTime = now - 120_000;
    const terminalTime = now - 1_000;

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `ses_quiet_terminal_${state}`,
        "Quiet terminal child",
        "/home/user/parentproj",
        quietTime,
        quietTime,
        parentId,
        "proj-parent",
      ],
    );

    const tmpDir = mkdtempSync(join(tmpdir(), "ccmon-quiet-terminal-"));
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      `${JSON.stringify({
        event,
        state,
        timestamp: new Date(terminalTime).toISOString(),
        session_id: `ses_quiet_terminal_${state}`,
        working_dir: "/home/user/parentproj",
      })}\n`,
    );

    const backendWithStatus = new OpencodeBackend(db, 5000, statusPath);
    const project = (await backendWithStatus.scanProjects())[0];
    const subagents = await backendWithStatus.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].agentId).toBe(`ses_quiet_terminal_${state}`);
    expect(subagents[0].isActive).toBe(false);
    expect(subagents[0].lastMessageTime).toBe(
      new Date(terminalTime).toISOString(),
    );
  });

  test("reloads a same-size status-log replacement when its inode changes", async () => {
    const now = Date.now();
    setupParent();
    const replacementDir = mkdtempSync(
      join(tmpdir(), "ccmon-inode-replacement-"),
    );
    const statusPath = join(replacementDir, "opencode-status.jsonl");
    const timestamp = now - 1_000;
    const makeStatus = (state: SessionState) =>
      `${JSON.stringify({
        event: "same.event",
        state,
        timestamp: new Date(timestamp).toISOString(),
        session_id: "ses_parent",
        working_dir: "/home/user/parentproj",
      })}\n`;
    const running = makeStatus("running");
    const stopped = makeStatus("stopped");
    expect(stopped.length).toBe(running.length);
    writeFileSync(statusPath, running);
    const backend = new OpencodeBackend(db, 5_000, statusPath);
    await expect(
      backend.resolveState((await backend.scanProjects())[0]),
    ).resolves.toBe("running");

    const original = statSync(statusPath);
    const replacementPath = join(replacementDir, "replacement-status.jsonl");
    writeFileSync(replacementPath, stopped);
    utimesSync(replacementPath, original.atime, original.mtime);
    renameSync(replacementPath, statusPath);

    await expect(
      backend.resolveState((await backend.scanProjects())[0]),
    ).resolves.toBe("stopped");
  });

  test("quiet linked sub-agent drops after terminal retention window uses terminal time", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const quietTime = now - 120_000;
    const terminalTime = now - 31_000;

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_quiet_terminal_expired",
        "Quiet terminal expired child",
        "/home/user/parentproj",
        quietTime,
        quietTime,
        parentId,
        "proj-parent",
      ],
    );

    const tmpDir = mkdtempSync(join(tmpdir(), "ccmon-quiet-terminal-expired-"));
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      `${JSON.stringify({
        event: "session.idle",
        state: "stopped",
        timestamp: new Date(terminalTime).toISOString(),
        session_id: "ses_quiet_terminal_expired",
        working_dir: "/home/user/parentproj",
      })}\n`,
    );

    const backendWithStatus = new OpencodeBackend(db, 5000, statusPath);
    const project = (await backendWithStatus.scanProjects())[0];
    const subagents = await backendWithStatus.getSubagents(project);

    expect(subagents).toHaveLength(0);
  });

  test("resolveState returns running when parent is stale but child is active", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      now - 60000,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_active_state",
        "Active Child",
        "/home/user/parentproj",
        now - 10000,
        now,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("running");
  });

  test("resolveState returns running when parent is stale but linked child is quiet and non-terminal", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const quietTime = now - 120_000;

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      quietTime,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_quiet_child_keeps_parent_running",
        "Quiet Child",
        "/home/user/parentproj",
        quietTime,
        quietTime,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("running");
  });

  test("resolveState returns stopped when quiet linked child exceeds lifecycle fallback timeout", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const expired = now - SUBAGENT_LIFECYCLE_TIMEOUT_MS - 1_000;

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      expired,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_expired_quiet_child",
        "Expired Quiet Child",
        "/home/user/parentproj",
        expired,
        expired,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    const subagents = await backend.getSubagents(project);

    expect(state).toBe("stopped");
    expect(subagents).toHaveLength(0);
  });

  test("resolveState returns stopped when parent and all linked children exceed lifecycle timeout", async () => {
    const now = Date.now();
    const parentId = setupParent();
    const expired = now - SUBAGENT_LIFECYCLE_TIMEOUT_MS - 1_000;

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      expired,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_stale_state",
        "Stale Child",
        "/home/user/parentproj",
        expired,
        expired,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("stopped");
  });

  test("resolveState returns running via parent activity (regression guard)", async () => {
    const now = Date.now();
    const projId = "proj-regression";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "regressionproj",
      "/home/user/regressionproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_regression",
        "Regression",
        "/home/user/regressionproj",
        now - 60000,
        now,
        projId,
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("running");
  });

  test("resolveState returns stopped for stale parent with no children (regression guard)", async () => {
    const now = Date.now();
    const projId = "proj-nochild";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "nochildproj",
      "/home/user/nochildproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_nochild",
        "No Children",
        "/home/user/nochildproj",
        now - 120000,
        now - 120000,
        projId,
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("stopped");
  });

  test("resolveState keeps same-directory top-level peers independent when one peer is active", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      now - 60000,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_top_level_peer",
        "Top-level Peer",
        "/home/user/parentproj",
        now - 10000,
        now,
        "proj-parent",
      ],
    );

    const projects = await backend.scanProjects();
    const staleParent = projects.find(
      (project) => project.sessionId === parentId,
    );
    const activePeer = projects.find(
      (project) => project.sessionId === "ses_top_level_peer",
    );

    expect(staleParent).toBeDefined();
    expect(activePeer).toBeDefined();
    if (!staleParent || !activePeer) {
      throw new Error(
        "expected both same-directory peer sessions to be visible",
      );
    }

    await expect(backend.resolveState(staleParent)).resolves.toBe("stopped");
    await expect(backend.resolveState(activePeer)).resolves.toBe("running");
  });

  test("resolveState returns stopped when fallback directory scan also finds nothing active", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      now - 120000,
      parentId,
    ]);

    // Stale unlinked session in same directory — should be ignored
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_stale_unlinked",
        "Stale Unlinked",
        "/home/user/parentproj",
        now - 120000,
        now - 120000,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("stopped");
  });

  test("buildProjectState ignores generic child time_updated when parent is older", async () => {
    const now = Date.now();
    const parentId = setupParent();

    const parentUpdated = now - 60000;
    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      parentUpdated,
      parentId,
    ]);

    const childUpdated = now - 10000;
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_lastupdated",
        "Child Recent",
        "/home/user/parentproj",
        now - 30000,
        childUpdated,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);
    expect(state.lastUpdated).toBe(new Date(parentUpdated).toISOString());
  });

  test("buildProjectState keeps stale top-level peer state and lastUpdated session-scoped when same-directory peer activity exists", async () => {
    const now = Date.now();
    const parentId = setupParent();

    const parentUpdated = now - 120_000;
    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      parentUpdated,
      parentId,
    ]);

    const childUpdated = now - 10_000;
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_unlinked_child_lastupdated",
        "Unlinked Child Recent",
        "/home/user/parentproj",
        now - 30_000,
        childUpdated,
        "proj-parent",
      ],
    );

    const project = {
      cwd: "/home/user/parentproj",
      projectName: "parentproj",
      sessionId: parentId,
      source: "opencode" as const,
    };
    const state = await buildProjectState(backend, project);
    expect(state.state).toBe("stopped");
    expect(state.lastUpdated).toBe(new Date(parentUpdated).toISOString());
  });

  test("buildProjectState lastUpdated uses parent time_updated when parent is more recent", async () => {
    const now = Date.now();
    const parentId = setupParent();

    const parentUpdated = now;
    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      parentUpdated,
      parentId,
    ]);

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_old_lastupdated",
        "Child Old",
        "/home/user/parentproj",
        now - 120000,
        now - 60000,
        parentId,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await buildProjectState(backend, project);
    expect(state.lastUpdated).toBe(new Date(parentUpdated).toISOString());
  });

  test("getSubagents marks child inactive via status log even when SQLite time_updated is recent", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_status_inactive",
        "Status Inactive Child",
        "/home/user/parentproj",
        now - 5000,
        now,
        parentId,
        "proj-parent",
      ],
    );

    const tmpDir = mkdtempSync(join(tmpdir(), "ccmon-sub-status-"));
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      `${JSON.stringify({
        event: "session.idle",
        state: "stopped",
        timestamp: new Date(now).toISOString(),
        session_id: "ses_child_status_inactive",
        working_dir: "/home/user/parentproj",
      })}\n`,
    );

    const backendWithStatus = new OpencodeBackend(db, 5000, statusPath);
    const project = (await backendWithStatus.scanProjects())[0];
    const subagents = await backendWithStatus.getSubagents(project);

    expect(subagents).toHaveLength(1);
    expect(subagents[0].isActive).toBe(false);
  });
});

describe("OpencodeBackend — child lifecycle ordering", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);
  type LifecycleFixture = {
    name: string;
    state: SessionState;
  };

  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-child-lifecycle-"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupStaleParentAndChild(childUpdated = now - 20 * 60_000): {
    parentId: string;
    childId: string;
  } {
    const parentId = "ses_lifecycle_parent";
    const childId = "ses_lifecycle_child";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-lifecycle",
      "lifecycleproj",
      "/home/user/lifecycleproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        parentId,
        "Lifecycle parent",
        "/home/user/lifecycleproj",
        now - 30 * 60_000,
        now - 20 * 60_000,
        "proj-lifecycle",
      ],
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        childId,
        "Lifecycle child",
        "/home/user/lifecycleproj",
        now - 25 * 60_000,
        childUpdated,
        parentId,
        "proj-lifecycle",
      ],
    );
    return { parentId, childId };
  }

  function makeLifecycleEvent(
    sessionId: string,
    name: string,
    state: SessionState,
    timestamp: number | string,
  ): string {
    return `${JSON.stringify({
      event: name,
      state,
      timestamp:
        typeof timestamp === "number"
          ? new Date(timestamp).toISOString()
          : timestamp,
      session_id: sessionId,
      working_dir: "/home/user/lifecycleproj",
    })}\n`;
  }

  function backendForStatus(contents: string): OpencodeBackend {
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(statusPath, contents);
    return new OpencodeBackend(db, 5000, statusPath);
  }

  function expectedChild(
    childId: string,
    isActive: boolean,
    lastMessageTime: number,
  ) {
    return {
      agentId: childId,
      slug: undefined,
      description: undefined,
      sessionName: "Lifecycle child",
      isActive,
      lastMessageTime: new Date(lastMessageTime).toISOString(),
      launchTime: new Date(now - 25 * 60_000).toISOString(),
    };
  }

  test("a resumed direct child promotes its stale parent and supplies its active enrichment", async () => {
    const { childId } = setupStaleParentAndChild();
    const resumedAt = now - 1_000;
    const backend = backendForStatus(
      makeLifecycleEvent(childId, "session.idle", "stopped", now - 2_000) +
        makeLifecycleEvent(childId, "chat.message", "running", resumedAt),
    );
    const project = (await backend.scanProjects())[0];

    const state = await buildProjectState(backend, project);

    expect(state.state).toBe("running");
    expect(state.subagentCount).toBe(1);
    expect(state.subagents).toEqual([expectedChild(childId, true, resumedAt)]);
  });

  const reactivationFixtures: LifecycleFixture[] = [
    { name: "session.created", state: "running" },
    { name: "chat.message", state: "running" },
    { name: "UserPromptSubmit", state: "running" },
  ];

  test.each(
    reactivationFixtures,
  )("newer $name evidence reactivates a child after stopped", async ({
    name,
    state,
  }) => {
    const { childId } = setupStaleParentAndChild();
    const activityAt = now - 1_000;
    const backend = backendForStatus(
      makeLifecycleEvent(childId, "session.idle", "stopped", now - 2_000) +
        makeLifecycleEvent(childId, name, state, activityAt),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, true, activityAt),
    ]);
  });

  const terminalFixtures: LifecycleFixture[] = [
    { name: "session.idle", state: "stopped" },
    { name: "session.error", state: "error" },
    { name: "session.deleted", state: "closed" },
  ];

  test.each(
    terminalFixtures,
  )("newer $name evidence restores terminal child behavior", async ({
    name,
    state,
  }) => {
    const { childId } = setupStaleParentAndChild();
    const terminalAt = now - 1_000;
    const backend = backendForStatus(
      makeLifecycleEvent(childId, "chat.message", "running", now - 2_000) +
        makeLifecycleEvent(childId, name, state, terminalAt),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, false, terminalAt),
    ]);
    const aggregate = await buildProjectState(backend, project);
    expect(aggregate.subagents).toBeUndefined();
    expect(aggregate.subagentCount).toBeUndefined();
  });

  const expiredEvidenceFixtures: Array<LifecycleFixture & { timeout: number }> =
    [
      {
        name: "tool.execute.after",
        state: "running",
        timeout: SUBAGENT_LIFECYCLE_TIMEOUT_MS,
      },
      {
        name: "PermissionRequest",
        state: "waiting_for_permission",
        timeout: PERMISSION_STALE_MS,
      },
    ];

  test.each(
    expiredEvidenceFixtures,
  )("expired authoritative $name evidence does not fall back to fresh SQLite recency", async ({
    name,
    state,
    timeout,
  }) => {
    const { childId } = setupStaleParentAndChild(now - 1_000);
    const backend = backendForStatus(
      makeLifecycleEvent(
        childId,
        "session.idle",
        "stopped",
        now - timeout - 2,
      ) + makeLifecycleEvent(childId, name, state, now - timeout - 1),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
    await expect(backend.getSubagents(project)).resolves.toEqual([]);
  });

  test.each([
    {
      name: "tool.execute.after",
      state: "running" as const,
      timeout: SUBAGENT_LIFECYCLE_TIMEOUT_MS,
    },
    {
      name: "PermissionRequest",
      state: "waiting_for_permission" as const,
      timeout: PERMISSION_STALE_MS,
    },
  ])("keeps $name evidence active at its exact liveness boundary", async ({
    name,
    state,
    timeout,
  }) => {
    const { childId } = setupStaleParentAndChild();
    const boundaryTime = now - timeout;
    const backend = backendForStatus(
      makeLifecycleEvent(childId, name, state, boundaryTime),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, true, boundaryTime),
    ]);
  });

  test("retains terminal child evidence at the exact 30-second boundary", async () => {
    const { childId } = setupStaleParentAndChild();
    const terminalTime = now - SUBAGENT_EXPIRY_MS;
    const backend = backendForStatus(
      makeLifecycleEvent(childId, "session.idle", "stopped", terminalTime),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, false, terminalTime),
    ]);
  });

  test("uses fresh SQLite recency when the status tail has no valid lifecycle evidence", async () => {
    const { childId } = setupStaleParentAndChild(now - 1_000);
    const backend = backendForStatus(
      "not JSON\n" +
        makeLifecycleEvent(
          childId,
          "tool.execute.after",
          "running",
          "not-a-timestamp",
        ) +
        makeLifecycleEvent(childId, "Notification", "running", now - 500) +
        makeLifecycleEvent(childId, "SubagentStop", "running", now - 400) +
        makeLifecycleEvent(
          "ses_unrelated",
          "tool.execute.after",
          "running",
          now - 300,
        ),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, true, now - 1_000),
    ]);
  });

  test("orders valid child evidence numerically, then by later physical line on equal timestamps", async () => {
    const { childId } = setupStaleParentAndChild();
    const backend = backendForStatus(
      makeLifecycleEvent(
        childId,
        "chat.message",
        "running",
        "2026-07-16T11:59:30.000Z",
      ) +
        makeLifecycleEvent(
          childId,
          "session.idle",
          "stopped",
          "2026-07-16T12:30:00.000+01:00",
        ),
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("running");

    writeFileSync(
      join(tmpDir, "opencode-status.jsonl"),
      makeLifecycleEvent(
        childId,
        "tool.execute.after",
        "running",
        now - 1_000,
      ) + makeLifecycleEvent(childId, "session.idle", "stopped", now - 1_000),
    );
    const equalTimeBackend = new OpencodeBackend(
      db,
      5000,
      join(tmpDir, "opencode-status.jsonl"),
    );
    await expect(equalTimeBackend.resolveState(project)).resolves.toBe(
      "stopped",
    );
  });

  test("retains child terminal evidence beyond the legacy status-tail length", async () => {
    const { childId } = setupStaleParentAndChild(now - 1_000);
    const backend = backendForStatus(
      makeLifecycleEvent(childId, "session.idle", "stopped", now - 2_000) +
        `${"x".repeat(STATUS_LOG_TAIL_BYTES + 1)}\n`,
    );
    const project = (await backend.scanProjects())[0];

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
    await expect(backend.getSubagents(project)).resolves.toEqual([
      expectedChild(childId, false, now - 2_000),
    ]);
  });
});

describe("OpencodeBackend — polling", () => {
  let db: DB;
  let backend: OpencodeBackend;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    backend = new OpencodeBackend(
      db,
      50,
      join(tmpdir(), "nonexistent-status.jsonl"),
      50,
    );
  });

  test("polls MAX(time_updated) and fires onUpdate when changed", async () => {
    const now = Date.now();
    const projId = "proj-poll";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "pollproj",
      "/home/user/pollproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_poll",
        "Poll Session",
        "/home/user/pollproj",
        now - 60000,
        now - 1000,
        projId,
      ],
    );

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Wait for initial poll cycle
    await new Promise((r) => setTimeout(r, 150));

    // Insert with a newer timestamp so MAX changes
    const newer = Date.now();
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_poll2",
        "Poll Session 2",
        "/home/user/pollproj",
        newer,
        newer,
        projId,
      ],
    );

    await new Promise((r) => setTimeout(r, 150));
    stop();

    expect(calls.length).toBeGreaterThan(0);
  }, 3000);

  test("fires onUpdate on every poll tick, even without data changes", async () => {
    const now = Date.now();
    const projId = "proj-unchanged";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "unchangedproj",
      "/home/user/unchangedproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_unchanged",
        "Unchanged",
        "/home/user/unchangedproj",
        now,
        now,
        projId,
      ],
    );

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Wait several poll cycles (> 2) without any DB changes
    await new Promise((r) => setTimeout(r, 200));
    stop();

    // Should fire multiple times — every poll tick triggers onUpdate
    expect(calls.length).toBeGreaterThanOrEqual(2);
  }, 3000);

  test("stop() prevents further callbacks", async () => {
    const now = Date.now();
    const projId = "proj-stop";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "stopproj",
      "/home/user/stopproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      ["ses_stop", "Stop Session", "/home/user/stopproj", now, now, projId],
    );

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    await new Promise((r) => setTimeout(r, 100));
    stop();

    const countAfterStop = calls.length;

    // Wait more — no additional calls should fire after stop
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBe(countAfterStop);
  }, 3000);

  test("polling starts immediately on first call", async () => {
    const now = Date.now();
    const projId = "proj-immediate";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "immediateproj",
      "/home/user/immediateproj",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_immediate",
        "Immediate",
        "/home/user/immediateproj",
        now - 60000,
        now - 1000,
        projId,
      ],
    );

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Insert with newer timestamp
    await new Promise((r) => setTimeout(r, 70));
    const newer = Date.now();
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_immediate2",
        "Immediate 2",
        "/home/user/immediateproj",
        newer,
        newer,
        projId,
      ],
    );

    // Should fire quickly (50ms poll interval)
    await new Promise((r) => setTimeout(r, 100));
    stop();

    expect(calls.length).toBeGreaterThan(0);
  }, 3000);
});

describe("OpencodeBackend — status log", () => {
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-opencode-status-"));
  });

  function makeStatusEvent(
    sessionId: string,
    state: string,
    timestamp: string,
    event = "SessionStart",
  ): string {
    return `${JSON.stringify({
      event,
      state,
      timestamp,
      session_id: sessionId,
      working_dir: "/tmp",
    })}\n`;
  }

  function setupProject(
    projId: string,
    projName: string,
    cwd: string,
    sessionId: string,
    timeUpdated: number,
  ): void {
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      projName,
      cwd,
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        "Test Session",
        cwd,
        timeUpdated - 60000,
        timeUpdated,
        projId,
      ],
    );
  }

  test("status log state takes priority over timestamp inference", async () => {
    const now = Date.now();
    setupProject(
      "proj-s1",
      "statustest",
      "/home/user/statustest",
      "ses_s1",
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const t1 = new Date(now - 5000).toISOString();
    const t2 = new Date(now - 3000).toISOString();
    const t3 = new Date(now - 1000).toISOString();
    writeFileSync(
      statusPath,
      makeStatusEvent("ses_s1", "waiting_for_permission", t1) +
        makeStatusEvent("ses_s1", "running", t2) +
        makeStatusEvent("ses_s1", "stopped", t3),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("stopped");
  });

  test("falls back to timestamp when no matching events in status log", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-s2",
      "fallbacktest",
      "/home/user/fallbacktest",
      "ses_s2",
      oldTime,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent("ses_other", "running", new Date(now).toISOString()),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("stopped");
  });

  test("falls back to timestamp when status file does not exist", async () => {
    const now = Date.now();
    setupProject(
      "proj-s3",
      "nofiletest",
      "/home/user/nofiletest",
      "ses_s3",
      now,
    );

    const statusPath = join(tmpDir, "nonexistent", "opencode-status.jsonl");
    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("running");
  });

  test("skips corrupt JSON lines, uses valid lines", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-s4",
      "corrupttest",
      "/home/user/corrupttest",
      "ses_s4",
      oldTime,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const t = new Date(now - 1000).toISOString();
    writeFileSync(
      statusPath,
      `not valid json at all\n${makeStatusEvent("ses_s4", "running", t)}`,
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("running");
  });

  test("status log state resolves error state from plugin", async () => {
    const now = Date.now();
    setupProject("proj-s5", "errortest", "/home/user/errortest", "ses_s5", now);

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const t = new Date(now - 1000).toISOString();
    writeFileSync(statusPath, makeStatusEvent("ses_s5", "error", t));

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("error");
  });

  test("status log state maps closed to stopped", async () => {
    const now = Date.now();
    setupProject(
      "proj-s6",
      "closedtest",
      "/home/user/closedtest",
      "ses_s6",
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const t = new Date(now - 1000).toISOString();
    writeFileSync(statusPath, makeStatusEvent("ses_s6", "closed", t));

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("closed");
  });

  test("default statusLogPath resolves to XDG_STATE_HOME/ccmon/opencode-status.jsonl", async () => {
    const now = Date.now();
    setupProject(
      "proj-s7",
      "configtest",
      "/home/user/configtest",
      "ses_s7",
      now,
    );

    const stateDir = join(tmpDir, "custom-state");
    mkdirSync(join(stateDir, "ccmon"), { recursive: true });

    const statusPath = join(stateDir, "ccmon", "opencode-status.jsonl");
    const t = new Date(now - 1000).toISOString();
    writeFileSync(
      statusPath,
      makeStatusEvent("ses_s7", "waiting_for_permission", t),
    );

    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    try {
      const backend = new OpencodeBackend(db);
      const projects = await backend.scanProjects();
      const state = await backend.resolveState(projects[0]);

      expect(state).toBe("waiting_for_permission");
    } finally {
      if (prevXdgState !== undefined) {
        process.env.XDG_STATE_HOME = prevXdgState;
      } else {
        delete process.env.XDG_STATE_HOME;
      }
    }
  });

  test("empty status log file falls back to timestamp inference", async () => {
    const now = Date.now();
    setupProject("proj-s8", "emptytest", "/home/user/emptytest", "ses_s8", now);

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(statusPath, "");

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("running");
  });

  test("keeps an existing collection snapshot stable until the next scan", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-s9",
      "cachetest",
      "/home/user/cachetest",
      "ses_s9",
      oldTime,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const t1 = new Date(now - 5000).toISOString();
    writeFileSync(statusPath, makeStatusEvent("ses_s9", "running", t1));

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state1 = await backend.resolveState(projects[0]);
    expect(state1).toBe("running");

    // Small delay ensures mtime changes between writes
    await new Promise((r) => setTimeout(r, 10));

    const t2 = new Date(now - 1000).toISOString();
    writeFileSync(
      statusPath,
      makeStatusEvent("ses_s9", "running", t1) +
        makeStatusEvent("ses_s9", "stopped", t2),
    );

    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
    const refreshedProjects = await backend.scanProjects();
    await expect(backend.resolveState(refreshedProjects[0])).resolves.toBe(
      "stopped",
    );
  });

  test("active linked child keeps parent running after parent idle status", async () => {
    const now = Date.now();
    setupProject(
      "proj-linked-child-status",
      "linkedchild",
      "/home/user/linkedchild",
      "ses_parent_idle_linked",
      now - 120_000,
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_active_linked_child",
        "Active child",
        "/home/user/linkedchild",
        now - 10_000,
        now,
        "ses_parent_idle_linked",
        "proj-linked-child-status",
      ],
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_parent_idle_linked",
        "stopped",
        new Date(now - 1_000).toISOString(),
        "session.idle",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
  });

  test("quiet non-terminal linked child keeps parent running after parent idle status", async () => {
    const now = Date.now();
    const quietTime = now - 120_000;
    setupProject(
      "proj-quiet-linked-child-status",
      "quietlinkedchild",
      "/home/user/quietlinkedchild",
      "ses_parent_idle_quiet_linked",
      quietTime,
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_quiet_linked_child_status",
        "Quiet linked child",
        "/home/user/quietlinkedchild",
        quietTime,
        quietTime,
        "ses_parent_idle_quiet_linked",
        "proj-quiet-linked-child-status",
      ],
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_parent_idle_quiet_linked",
        "stopped",
        new Date(now - 1_000).toISOString(),
        "session.idle",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
  });

  test("quiet terminal linked child does not keep parent running", async () => {
    const now = Date.now();
    const quietTime = now - 120_000;
    setupProject(
      "proj-quiet-terminal-child-status",
      "quietterminalchild",
      "/home/user/quietterminalchild",
      "ses_parent_quiet_terminal_linked",
      quietTime,
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_quiet_terminal_child_status",
        "Quiet terminal child",
        "/home/user/quietterminalchild",
        quietTime,
        quietTime,
        "ses_parent_quiet_terminal_linked",
        "proj-quiet-terminal-child-status",
      ],
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_quiet_terminal_child_status",
        "stopped",
        new Date(now - 1_000).toISOString(),
        "session.idle",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("stopped");
  });

  test("active same-directory top-level peer does not keep sibling running after parent idle status", async () => {
    const now = Date.now();
    setupProject(
      "proj-unlinked-child-status",
      "unlinkedchild",
      "/home/user/unlinkedchild",
      "ses_parent_idle_unlinked",
      now - 120_000,
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_active_same_dir_peer",
        "Active same-dir peer",
        "/home/user/unlinkedchild",
        now - 10_000,
        now,
        "proj-unlinked-child-status",
      ],
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_parent_idle_unlinked",
        "stopped",
        new Date(now - 1_000).toISOString(),
        "session.idle",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const stoppedPeer = projects.find(
      (project) => project.sessionId === "ses_parent_idle_unlinked",
    );
    const activePeer = projects.find(
      (project) => project.sessionId === "ses_active_same_dir_peer",
    );

    expect(stoppedPeer).toBeDefined();
    expect(activePeer).toBeDefined();
    if (!stoppedPeer || !activePeer) {
      throw new Error(
        "expected both same-directory peer sessions to be visible",
      );
    }

    await expect(backend.resolveState(stoppedPeer)).resolves.toBe("stopped");
    await expect(backend.resolveState(activePeer)).resolves.toBe("running");
  });

  test("child stopped status does not keep stale parent running", async () => {
    const now = Date.now();
    setupProject(
      "proj-stopped-child-status",
      "stoppedchild",
      "/home/user/stoppedchild",
      "ses_parent_stopped_child",
      now - 120_000,
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_recent_but_stopped_child",
        "Stopped child",
        "/home/user/stoppedchild",
        now - 10_000,
        now,
        "ses_parent_stopped_child",
        "proj-stopped-child-status",
      ],
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_recent_but_stopped_child",
        "stopped",
        new Date(now - 1_000).toISOString(),
        "session.idle",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("stopped");
  });

  test("permission asked status resolves to waiting_for_permission", async () => {
    const now = Date.now();
    setupProject(
      "proj-perm-asked",
      "permasked",
      "/home/user/permasked",
      "ses_perm_asked",
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_perm_asked",
        "waiting_for_permission",
        new Date(now - 1_000).toISOString(),
        "permission.asked",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("permission replied status clears waiting_for_permission", async () => {
    const now = Date.now();
    setupProject(
      "proj-perm-replied",
      "permreplied",
      "/home/user/permreplied",
      "ses_perm_replied",
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_perm_replied",
        "waiting_for_permission",
        new Date(now - 10_000).toISOString(),
        "permission.asked",
      ) +
        makeStatusEvent(
          "ses_perm_replied",
          "running",
          new Date(now - 9_000).toISOString(),
          "permission.replied",
        ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
  });

  test("question asked status resolves like permission waiting state", async () => {
    const now = Date.now();
    setupProject(
      "proj-question-asked",
      "questionasked",
      "/home/user/questionasked",
      "ses_question_asked",
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_question_asked",
        "running",
        new Date(now - 1_000).toISOString(),
        "question.asked",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test.each([
    "question.replied",
    "question.rejected",
  ])("%s status clears waiting_for_permission immediately", async (replyEvent) => {
    const now = Date.now();
    setupProject(
      `proj-${replyEvent}`,
      replyEvent,
      `/home/user/${replyEvent}`,
      `ses_${replyEvent}`,
      now,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        `ses_${replyEvent}`,
        "waiting_for_permission",
        new Date(now - 10_000).toISOString(),
        "question.asked",
      ) +
        makeStatusEvent(
          `ses_${replyEvent}`,
          "running",
          new Date(now - 9_000).toISOString(),
          replyEvent,
        ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
  });

  test("stale permission asked status does not leave session waiting", async () => {
    const now = Date.now();
    setupProject(
      "proj-perm-stale",
      "permstale",
      "/home/user/permstale",
      "ses_perm_stale",
      now - 120_000,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_perm_stale",
        "waiting_for_permission",
        new Date(now - 10 * 60_000).toISOString(),
        "permission.asked",
      ),
    );

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    await expect(backend.resolveState(projects[0])).resolves.toBe("stopped");
  });
});

describe("OpencodeBackend — watchForChanges dual-mode (status log exists)", () => {
  let db: DB;
  let tmpDir: string;
  let statusPath: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-dual-mode-"));
    statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(statusPath, "");
  });

  function makeStatusEvent(
    sessionId: string,
    state: string,
    timestamp: string,
  ): string {
    return `${JSON.stringify({
      event: "chat.message",
      state,
      timestamp,
      session_id: sessionId,
      working_dir: "/tmp",
    })}\n`;
  }

  test("fs.watch fires onUpdate after status file is modified", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 50);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Let initial setup settle (no calls expected during setup)
    await new Promise((r) => setTimeout(r, 100));
    const beforeWrite = calls.length;

    // Write to status file → fs.watch fires → debounce → onUpdate
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_dual",
        "running",
        new Date(Date.now()).toISOString(),
      ),
    );

    // Wait for debounce (200ms) + processing
    await new Promise((r) => setTimeout(r, 350));
    stop();

    expect(calls.length).toBeGreaterThan(beforeWrite);
  }, 5000);

  test("200ms debounce coalesces rapid writes into fewer callbacks", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 2000);

    const callTimes: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      callTimes.push(Date.now());
    });

    // Background polling at 2000ms — unlikely to fire during test
    await new Promise((r) => setTimeout(r, 100));
    const afterSetup = callTimes.length;

    // Write multiple times in rapid succession (< 200ms apart)
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_debounce",
        "running",
        new Date(Date.now()).toISOString(),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_debounce2",
        "stopped",
        new Date(Date.now()).toISOString(),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(
      statusPath,
      makeStatusEvent(
        "ses_debounce3",
        "waiting_for_permission",
        new Date(Date.now()).toISOString(),
      ),
    );

    // Wait for debounce window (200ms) to close + callback
    await new Promise((r) => setTimeout(r, 300));
    stop();

    // Rapid writes within same debounce window → at most 1 additional
    // fs.watch callback (debounce coalesces them). Any extra callbacks
    // would come from polling, which fires at 2000ms (unlikely in this window).
    const postWrite = callTimes.length - afterSetup;
    expect(postWrite).toBeLessThanOrEqual(2);
  }, 5000);

  test("change-aware poll stays silent on an unchanged file, fires on change", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 50);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Multiple poll cycles at 50ms with no file change → no callbacks
    // (the baseline is captured at start without triggering an update).
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.length).toBe(0);

    // Changing the file is picked up by the change-aware poll (and/or the
    // fs.watch), firing onUpdate.
    writeFileSync(
      statusPath,
      makeStatusEvent("ses_change", "running", new Date().toISOString()),
    );
    await new Promise((r) => setTimeout(r, 250));
    stop();

    expect(calls.length).toBeGreaterThan(0);
  }, 5000);

  test("falls back to polling-only when status file is deleted", async () => {
    const backend = new OpencodeBackend(db, 50, statusPath, 2000);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Initial settle: background polling at 2000ms → 0 calls in 100ms
    await new Promise((r) => setTimeout(r, 100));
    const beforeDelete = calls.length;

    unlinkSync(statusPath);
    expect(existsSync(statusPath)).toBe(false);

    // fs.watch detects deletion → 200ms debounce → fallback to polling
    // at pollIntervalMs=50. Wait for several poll cycles.
    await new Promise((r) => setTimeout(r, 500));
    const countAfterFallback = calls.length;

    // Polling continues after fallback
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(countAfterFallback).toBeGreaterThan(beforeDelete);
    expect(calls.length).toBeGreaterThan(countAfterFallback);
  }, 5000);

  test("custom statusPollIntervalMs used for background polling in dual-mode", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 200);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Wait 150ms — with 200ms interval, should get at most 1 poll callback
    await new Promise((r) => setTimeout(r, 150));
    stop();

    expect(calls.length).toBeLessThanOrEqual(1);
  }, 5000);

  test("stop() tears down both fs.watch and polling", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 50);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    await new Promise((r) => setTimeout(r, 150));
    stop();
    const countAtStop = calls.length;

    // Wait more — no further callbacks after stop
    await new Promise((r) => setTimeout(r, 200));

    expect(calls.length).toBe(countAtStop);
  }, 5000);

  test("resolveState uses status log events after watchForChanges update", async () => {
    const now = Date.now();
    const projId = "proj-dual-integrate";
    const cwd = "/home/user/dualproj";
    const sessionId = "ses_dual_integrate";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "dualproj",
      cwd,
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionId, "Dual Session", cwd, now - 60000, now, projId],
    );

    const backend = new OpencodeBackend(db, 5000, statusPath, 50);

    // Initial state: status file is empty → falls back to timestamp → running
    const projects = await backend.scanProjects();
    const initialState = await backend.resolveState(projects[0]);
    expect(initialState).toBe("running");

    const calls: string[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push("changed");
    });

    await new Promise((r) => setTimeout(r, 100));

    // Write a status event marking the session as stopped
    writeFileSync(
      statusPath,
      makeStatusEvent(sessionId, "stopped", new Date(Date.now()).toISOString()),
    );

    // Wait for fs.watch → debounce → onUpdate → state rebuild
    await new Promise((r) => setTimeout(r, 400));

    const refreshedProjects = await backend.scanProjects();
    const finalState = await backend.resolveState(refreshedProjects[0]);
    expect(finalState).toBe("stopped");
    expect(calls.length).toBeGreaterThan(0);

    stop();
  }, 5000);

  test("sub-agent marked inactive via status log after watchForChanges", async () => {
    const now = Date.now();
    const projId = "proj-dual-sub";
    const cwd = "/home/user/dualsubproj";
    const parentId = "ses_dual_parent";
    const childId = "ses_dual_child";

    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "dualsubproj",
      cwd,
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [parentId, "Parent", cwd, now - 60000, now, projId],
    );
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [childId, "Child", cwd, now - 5000, now, parentId, projId],
    );

    const backend = new OpencodeBackend(db, 5000, statusPath, 50);
    const projects = await backend.scanProjects();
    const initialSubs = await backend.getSubagents(projects[0]);
    expect(initialSubs).toHaveLength(1);
    expect(initialSubs[0].isActive).toBe(true);

    // Delay ensures writeFileSync mtime differs from beforeEach's empty file mtime
    await new Promise((r) => setTimeout(r, 20));

    // Write idle event for the sub-agent
    writeFileSync(
      statusPath,
      makeStatusEvent(childId, "stopped", new Date(Date.now()).toISOString()),
    );

    const { stop } = backend.watchForChanges(() => {});
    await new Promise((r) => setTimeout(r, 400));

    const refreshedProjects = await backend.scanProjects();
    const updatedSubs = await backend.getSubagents(refreshedProjects[0]);
    expect(updatedSubs).toHaveLength(1);
    expect(updatedSubs[0].isActive).toBe(false);

    stop();
  }, 5000);
});

describe("OpencodeBackend — status log tail-cap", () => {
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-opencode-tailcap-"));
  });

  function makeStatusLine(
    sessionId: string,
    state: string,
    timestamp: string,
  ): string {
    return `${JSON.stringify({
      event: "SessionStart",
      state,
      timestamp,
      session_id: sessionId,
      working_dir: "/tmp",
    })}\n`;
  }

  function setupProject(
    projId: string,
    projName: string,
    cwd: string,
    sessionId: string,
    timeUpdated: number,
  ): void {
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      projName,
      cwd,
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        "Test Session",
        cwd,
        timeUpdated - 60000,
        timeUpdated,
        projId,
      ],
    );
  }

  test("large status log is tail-capped to STATUS_LOG_TAIL_BYTES and still resolves correct state", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-tailcap",
      "tailcaptest",
      "/home/user/tailcaptest",
      "ses_tailcap",
      oldTime,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");

    // Fill file with padding lines to exceed STATUS_LOG_TAIL_BYTES
    const paddingLine = makeStatusLine(
      "ses_other",
      "stopped",
      new Date(oldTime).toISOString(),
    );
    // Each padding line is ~110 bytes; write enough to exceed the cap
    const linesNeeded =
      Math.ceil((STATUS_LOG_TAIL_BYTES * 2) / paddingLine.length) + 1;
    const padding = paddingLine.repeat(linesNeeded);

    // The target session's event at the very end of the file
    const targetTs = new Date(now - 1000).toISOString();
    const targetLine = makeStatusLine("ses_tailcap", "running", targetTs);

    writeFileSync(statusPath, padding + targetLine);

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    // The target event is within the tail — state must be resolved from it
    expect(state).toBe("running");
  });

  test("reads target session activity beyond the legacy tail length", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-tailcap2",
      "tailcaptest2",
      "/home/user/tailcaptest2",
      "ses_tailcap2",
      oldTime, // stale → timestamp inference → stopped
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");

    // Build a file larger than the legacy tail with target activity at its start.
    const targetTs = new Date(now - 5000).toISOString();
    const targetLine = makeStatusLine("ses_tailcap2", "running", targetTs);

    const paddingLine = makeStatusLine(
      "ses_other",
      "stopped",
      new Date(oldTime).toISOString(),
    );
    const linesNeeded =
      Math.ceil((STATUS_LOG_TAIL_BYTES * 2) / paddingLine.length) + 1;
    const padding = paddingLine.repeat(linesNeeded);

    writeFileSync(statusPath, targetLine + padding);

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("running");
  });

  test("file below STATUS_LOG_TAIL_BYTES is read in full without slicing", async () => {
    const now = Date.now();
    const oldTime = now - 120_000;
    setupProject(
      "proj-small",
      "smalltest",
      "/home/user/smalltest",
      "ses_small",
      oldTime,
    );

    const statusPath = join(tmpDir, "opencode-status.jsonl");
    const ts = new Date(now - 1000).toISOString();
    // Single line — well below the cap
    writeFileSync(statusPath, makeStatusLine("ses_small", "stopped", ts));

    const backend = new OpencodeBackend(db, 5000, statusPath);
    const projects = await backend.scanProjects();
    const state = await backend.resolveState(projects[0]);

    expect(state).toBe("stopped");
  });
});

describe("OpencodeBackend — enrichMessages decomposition", () => {
  let db: DB;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
  });

  function setupSession(): { sessionId: string; backend: OpencodeBackend } {
    const now = Date.now();
    const projId = "proj-decomp";
    run(db, "INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      projId,
      "decompproj",
      "/home/user/decompproj",
    ]);
    const sessionId = "ses_decomp";
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        "Decomp Session",
        "/home/user/decompproj",
        now - 60000,
        now,
        projId,
      ],
    );
    return { sessionId, backend: new OpencodeBackend(db) };
  }

  test("extractAssistantEnrichment: model, tokens, and activity extracted from single assistant message", async () => {
    const { sessionId, backend } = setupSession();
    const msgId = "msg-asst-decomp";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({
          role: "assistant",
          modelID: "claude-sonnet-4-6",
          tokens: { input: 200, output: 80, cache: { read: 1000 } },
        }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-text-decomp",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ type: "text", text: "Working on your task now." }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-tool-decomp",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ type: "tool", tool: "Edit" }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBe("claude-sonnet-4-6");
    expect(enrichment.inputTokens).toBe(1200); // 1000 cache.read + 200 input
    expect(enrichment.outputTokens).toBe(80);
    expect(enrichment.latestAssistantActivity?.text).toBe(
      "Working on your task now.",
    );
    expect(enrichment.latestAssistantActivity?.tool).toBe("Edit");
  });

  test("extractUserActivity: text extracted from user message parts via typed parser", async () => {
    const { sessionId, backend } = setupSession();
    const msgId = "msg-user-decomp";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 500,
        Date.now() - 500,
        JSON.stringify({ role: "user" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-user-decomp",
        msgId,
        sessionId,
        Date.now() - 500,
        Date.now() - 500,
        JSON.stringify({
          type: "text",
          text: "Please fix the bug in parser.ts",
        }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.latestUserActivity?.text).toBe(
      "Please fix the bug in parser.ts",
    );
    expect(enrichment.latestUserActivity?.isCommand).toBe(false);
  });

  test("malformed part.data is skipped gracefully without crashing", async () => {
    const { sessionId, backend } = setupSession();
    const msgId = "msg-bad-parts";
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ role: "assistant", modelID: "claude-haiku" }),
      ],
    );
    // Corrupt part data
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-corrupt",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        "not valid json {{",
      ],
    );
    // Unknown part type
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-unknown",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ type: "image", url: "http://x" }),
      ],
    );
    // Valid text part last
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-valid",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ type: "text", text: "Here is the analysis." }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.model).toBe("claude-haiku");
    expect(enrichment.latestAssistantActivity?.text).toBe(
      "Here is the analysis.",
    );
  });

  test("long text in parts is truncated to 200 chars", async () => {
    const { sessionId, backend } = setupSession();
    const msgId = "msg-long";
    const longText = "a".repeat(500);
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ role: "assistant", modelID: "claude-haiku" }),
      ],
    );
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "part-long",
        msgId,
        sessionId,
        Date.now() - 1000,
        Date.now() - 1000,
        JSON.stringify({ type: "text", text: longText }),
      ],
    );

    const project = (await backend.scanProjects())[0];
    const enrichment = await backend.enrichProject(project);

    expect(enrichment.latestAssistantActivity?.text?.length).toBe(200);
  });
});

describe("OpencodeBackend — recursive blocker aggregation", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-recursive-blockers-"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function addSession(
    id: string,
    parentId: string | null = null,
    archived = false,
    updated = now - 10 * 60_000,
  ): void {
    run(db, "INSERT OR IGNORE INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-blockers",
      "blockers",
      "/home/user/blockers",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        id,
        "/home/user/blockers",
        updated - 1_000,
        updated,
        archived ? updated : null,
        parentId,
        "proj-blockers",
      ],
    );
  }

  function addMessage(
    sessionId: string,
    id: string,
    role: "assistant" | "user",
    createdAt: number,
    updatedAt = createdAt,
  ): void {
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [id, sessionId, createdAt, updatedAt, JSON.stringify({ role })],
    );
  }

  function status(
    sessionId: string,
    event: string,
    state: SessionState,
    timestamp = now - 1_000,
    requestId?: string,
    blockerKind?: "question" | "permission",
  ): string {
    return `${JSON.stringify({
      event,
      state,
      timestamp: new Date(timestamp).toISOString(),
      session_id: sessionId,
      working_dir: "/home/user/blockers",
      ...(requestId ? { request_id: requestId } : {}),
      ...(blockerKind ? { blocker_kind: blockerKind } : {}),
    })}\n`;
  }

  function backendForStatus(contents: string): OpencodeBackend {
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(statusPath, contents);
    return new OpencodeBackend(db, 5_000, statusPath);
  }

  async function projectFor(backend: OpencodeBackend, sessionId = "root") {
    const project = (await backend.scanProjects()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!project) throw new Error(`missing visible root ${sessionId}`);
    return project;
  }

  test("promotes a root for arbitrary-depth blockers across branches and preserves the blocker timestamp", async () => {
    addSession("root");
    addSession("branch-a", "root");
    addSession("branch-b", "root");
    addSession("depth-three", "branch-a");
    const askedAt = now - 2_000;
    const backend = backendForStatus(
      status(
        "depth-three",
        "question.asked",
        "waiting_for_permission",
        askedAt,
        "q-1",
        "question",
      ),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe(
      "waiting_for_permission",
    );
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(askedAt).toISOString(),
    );
  });

  test("keeps duplicate request IDs independent by descendant session and blocker kind", async () => {
    addSession("root");
    addSession("question-child", "root");
    addSession("permission-child", "root");
    const backend = backendForStatus(
      status(
        "question-child",
        "question.asked",
        "waiting_for_permission",
        now - 4_000,
        "same",
        "question",
      ) +
        status(
          "permission-child",
          "permission.asked",
          "waiting_for_permission",
          now - 3_000,
          "same",
          "permission",
        ) +
        status(
          "question-child",
          "question.replied",
          "running",
          now - 2_000,
          "same",
          "question",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("clears only the matching request when a descendant has multiple blockers", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status(
        "child",
        "question.asked",
        "waiting_for_permission",
        now - 3_000,
        "question-1",
        "question",
      ) +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 2_000,
          "question-2",
          "question",
        ) +
        status(
          "child",
          "question.replied",
          "running",
          now - 1_000,
          "question-1",
          "question",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("keeps a same-kind legacy blocker when a keyed reply resolves its exact blocker", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("child", "question.asked", "waiting_for_permission", now - 3_000) +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 2_000,
          "keyed-question",
          "question",
        ) +
        status(
          "child",
          "question.replied",
          "running",
          now - 1_000,
          "keyed-question",
          "question",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test.each([
    ["question.replied", "question"],
    ["permission.rejected", "permission"],
  ] as const)("%s recovers a same-kind legacy blocker when no exact request exists", async (replyEvent, kind) => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("child", `${kind}.asked`, "waiting_for_permission", now - 2_000) +
        status(
          "child",
          replyEvent,
          "running",
          now - 1_000,
          `new-${kind}-request`,
          kind,
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("does not let a keyed question reply clear a legacy permission blocker", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status(
        "child",
        "permission.asked",
        "waiting_for_permission",
        now - 2_000,
      ) +
        status(
          "child",
          "question.rejected",
          "running",
          now - 1_000,
          "question-request",
          "question",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("uses a conservative per-session legacy slot for ID-less lifecycle records", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("child", "question.asked", "waiting_for_permission", now - 3_000) +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 2_000,
        ) +
        status("child", "question.replied", "running", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("traverses archived intermediates without letting archived blocked descendants promote the root", async () => {
    addSession("root");
    addSession("archived-middle", "root", true);
    addSession("archived-child", "archived-middle");
    const backend = backendForStatus(
      status(
        "archived-child",
        "permission.asked",
        "waiting_for_permission",
        now - 1_000,
        "p-1",
        "permission",
      ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "stopped",
    );
  });

  test("excludes generic, terminal, and archived descendant row recency from project freshness", async () => {
    const staleAt = now - 2 * 60 * 60_000;
    addSession("generic-root", null, false, staleAt);
    addSession("generic-child", "generic-root", false, now);
    addSession("terminal-root", null, false, staleAt);
    addSession("terminal-child", "terminal-root", false, now);
    addSession("archived-root", null, false, staleAt);
    addSession("archived-child", "archived-root", true, now);
    const backend = backendForStatus(
      status("terminal-child", "session.idle", "stopped", now - 1_000) +
        status(
          "archived-child",
          "permission.asked",
          "waiting_for_permission",
          now - 500,
          "archived",
          "permission",
        ),
    );

    const states = await Promise.all(
      ["generic-root", "terminal-root", "archived-root"].map(
        async (sessionId) =>
          buildProjectState(backend, await projectFor(backend, sessionId)),
      ),
    );

    expect(states.map((state) => state.lastUpdated)).toEqual([
      new Date(staleAt).toISOString(),
      new Date(staleAt).toISOString(),
      new Date(staleAt).toISOString(),
    ]);
    expect(states.map((state) => state.state)).toEqual([
      "running",
      "stopped",
      "stopped",
    ]);
    expect(filterStaleProjects(states, 1)).toEqual([]);
    await expect(
      backend.getSubagents(await projectFor(backend, "archived-root")),
    ).resolves.toEqual([]);
  });

  test("does not attach missing-parent sessions or disconnected cycles to a root", async () => {
    addSession("root");
    addSession("orphan", "missing-parent");
    addSession("cycle-a", "cycle-b");
    addSession("cycle-b", "cycle-a");
    const backend = backendForStatus(
      status(
        "orphan",
        "question.asked",
        "waiting_for_permission",
        now - 1_000,
        "orphan",
        "question",
      ) +
        status(
          "cycle-a",
          "permission.asked",
          "waiting_for_permission",
          now - 1_000,
          "cycle",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "stopped",
    );
  });

  test("excludes a corrupted root re-entry instead of traversing it as its own descendant", async () => {
    addSession("root");
    addSession("child", "root");
    run(db, "UPDATE session SET parent_id = ? WHERE id = ?", ["child", "root"]);
    const backend = backendForStatus(
      status(
        "child",
        "permission.asked",
        "waiting_for_permission",
        now - 1_000,
        "blocked",
        "permission",
      ),
    );
    const corruptedRoot = {
      cwd: "/home/user/blockers",
      projectName: "blockers",
      sessionId: "root",
      source: "opencode" as const,
    };

    await expect(backend.resolveState(corruptedRoot)).resolves.toBe("stopped");
  });

  test("invalid blocker timestamps cannot block and a running event after an ask cannot clear it", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "question.asked",
        state: "waiting_for_permission",
        timestamp: "not-a-timestamp",
        session_id: "child",
        working_dir: "/home/user/blockers",
        request_id: "invalid",
      })}\n` +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 2_000,
          "active",
          "question",
        ) +
        status("child", "tool.execute.after", "running", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("applies terminal evidence in order and only to the affected descendant", async () => {
    addSession("terminal-root");
    addSession("terminal-child", "terminal-root");
    const terminalBackend = backendForStatus(
      status(
        "terminal-child",
        "question.asked",
        "waiting_for_permission",
        now - 2_000,
        "terminal",
        "question",
      ) + status("terminal-child", "session.idle", "stopped", now - 1_000),
    );
    await expect(
      terminalBackend.resolveState(
        await projectFor(terminalBackend, "terminal-root"),
      ),
    ).resolves.toBe("stopped");

    addSession("root");
    addSession("ended-child", "root");
    addSession("blocked-child", "root");
    const backend = backendForStatus(
      status(
        "ended-child",
        "question.asked",
        "waiting_for_permission",
        now - 4_000,
        "ended",
        "question",
      ) +
        status("ended-child", "session.idle", "stopped", now - 3_000) +
        status(
          "blocked-child",
          "permission.asked",
          "waiting_for_permission",
          now - 2_000,
          "live",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("treats the exact five-minute boundary as stale while a later blocker remains fresh", async () => {
    addSession("root");
    addSession("boundary-child", "root");
    const boundaryBackend = backendForStatus(
      status(
        "boundary-child",
        "permission.asked",
        "waiting_for_permission",
        now - PERMISSION_STALE_MS,
        "boundary",
        "permission",
      ),
    );

    await expect(
      boundaryBackend.resolveState(await projectFor(boundaryBackend)),
    ).resolves.not.toBe("waiting_for_permission");

    const freshBackend = backendForStatus(
      status(
        "boundary-child",
        "permission.asked",
        "waiting_for_permission",
        now - PERMISSION_STALE_MS + 1,
        "fresh",
        "permission",
      ),
    );
    await expect(
      freshBackend.resolveState(await projectFor(freshBackend)),
    ).resolves.toBe("waiting_for_permission");
  });

  test("keeps top-level roots isolated and preserves closed/error root precedence", async () => {
    addSession("root");
    addSession("child", "root");
    addSession("other-root");
    addSession("other-child", "other-root");
    const backend = backendForStatus(
      status(
        "child",
        "question.asked",
        "waiting_for_permission",
        now - 3_000,
        "q",
        "question",
      ) +
        status("root", "session.deleted", "closed", now - 2_000) +
        status(
          "other-child",
          "permission.asked",
          "waiting_for_permission",
          now - 1_000,
          "p",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "closed",
    );
    await expect(
      backend.resolveState(await projectFor(backend, "other-root")),
    ).resolves.toBe("waiting_for_permission");

    addSession("error-root");
    addSession("error-child", "error-root");
    const errorBackend = backendForStatus(
      status(
        "error-child",
        "permission.asked",
        "waiting_for_permission",
        now - 2_000,
        "blocked",
        "permission",
      ) + status("error-root", "session.error", "error", now - 1_000),
    );
    await expect(
      errorBackend.resolveState(await projectFor(errorBackend, "error-root")),
    ).resolves.toBe("error");
  });

  test("keeps reconstructed terminal barriers through late lifecycle and running evidence", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("root", "session.error", "error", now - 4_000) +
        status(
          "root",
          "question.asked",
          "waiting_for_permission",
          now - 3_000,
          "late-question",
          "question",
        ) +
        status(
          "root",
          "question.replied",
          "running",
          now - 2_000,
          "late-question",
          "question",
        ) +
        status(
          "root",
          "question.rejected",
          "running",
          now - 2_000,
          "late-question",
          "question",
        ) +
        status(
          "root",
          "permission.asked",
          "waiting_for_permission",
          now - 2_000,
          "late-permission",
          "permission",
        ) +
        status(
          "root",
          "permission.rejected",
          "running",
          now - 2_000,
          "late-permission",
          "permission",
        ) +
        status("root", "tool.execute.after", "running", now - 1_000) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 1_000,
          "child",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "error",
    );
  });

  test("advances an errored generation to a later deleted terminal state", async () => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.error", "error", now - 2_000) +
        status("root", "session.deleted", "closed", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "closed",
    );
  });

  test("closed remains terminal despite a later session.created event", async () => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.deleted", "closed", now - 3_000) +
        status("root", "session.created", "running", now - 2_000) +
        status("root", "tool.execute.after", "running", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "closed",
    );
  });

  test("error followed by idle and chat resumes the latest generation", async () => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.error", "error", now - 4_000) +
        status("root", "session.idle", "stopped", now - 3_000) +
        status("root", "chat.message", "running", now - 2_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("late error-generation activity stays suppressed until chat, then a new question blocks", async () => {
    addSession("root");
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(
      statusPath,
      status("root", "session.error", "error", now - 5_000) +
        status("root", "tool.execute.after", "running", now - 4_000) +
        status(
          "root",
          "question.asked",
          "waiting_for_permission",
          now - 3_000,
          "late",
          "question",
        ) +
        status("root", "chat.message", "running", now - 2_000),
    );
    const backend = new OpencodeBackend(db, 5_000, statusPath);
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("running");

    writeFileSync(
      statusPath,
      `${readFileSync(statusPath, "utf-8")}${status(
        "root",
        "question.asked",
        "waiting_for_permission",
        now - 1_000,
        "fresh",
        "question",
      )}`,
    );
    const refreshedProject = await projectFor(backend);
    await expect(backend.resolveState(refreshedProject)).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("raw UserPromptSubmit reactivates an errored generation", async () => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.error", "error", now - 2_000) +
        status("root", "UserPromptSubmit", "running", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("a strictly newer root user message reactivates an errored generation", async () => {
    addSession("root");
    const errorAt = now - 4_000;
    const userMessageAt = now - 2_000;
    addMessage("root", "root-user", "user", userMessageAt);
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(userMessageAt).toISOString(),
    );
  });

  test("a persisted child user message after idle reactivates the direct child and root", async () => {
    addSession("root");
    addSession("child", "root");
    const userMessageAt = now - 1_500;
    addMessage("child", "child-user", "user", userMessageAt);
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 3_000) +
        status("child", "session.idle", "stopped", now - 2_000),
    );
    const project = await projectFor(backend);

    const state = await buildProjectState(backend, project);

    expect(state.state).toBe("running");
    expect(state.subagentCount).toBe(1);
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents?.[0]).toMatchObject({
      agentId: "child",
      isActive: true,
      lastMessageTime: new Date(userMessageAt).toISOString(),
    });
    expect(state.lastUpdated).toBe(new Date(userMessageAt).toISOString());
  });

  test("a persisted user message in a nested descendant promotes an idle root", async () => {
    addSession("root");
    addSession("middle", "root");
    addSession("leaf", "middle");
    const userMessageAt = now - 1_500;
    addMessage("leaf", "leaf-user", "user", userMessageAt);
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 4_000) +
        status("middle", "session.idle", "stopped", now - 3_000) +
        status("leaf", "session.idle", "stopped", now - 2_000),
    );

    const state = await buildProjectState(backend, await projectFor(backend));

    expect(state.state).toBe("running");
    expect(state.lastUpdated).toBe(new Date(userMessageAt).toISOString());
    expect(state.subagentCount).toBeUndefined();
    expect(state.subagents?.[0]).toMatchObject({
      agentId: "middle",
      isActive: false,
    });
  });

  test("an archived descendant user message does not promote an idle root", async () => {
    addSession("root");
    addSession("archived-child", "root", true);
    addMessage("archived-child", "archived-child-user", "user", now - 1_500);
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 2_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "stopped",
    );
  });

  test("persisted descendant activity stays isolated to its own root", async () => {
    addSession("root");
    addSession("other-root");
    addSession("other-child", "other-root");
    addMessage("other-child", "other-child-user", "user", now - 1_500);
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 3_000) +
        status("other-root", "session.idle", "stopped", now - 3_000) +
        status("other-child", "session.idle", "stopped", now - 2_000),
    );

    await expect(
      backend.resolveState(await projectFor(backend, "root")),
    ).resolves.toBe("stopped");
    await expect(
      backend.resolveState(await projectFor(backend, "other-root")),
    ).resolves.toBe("running");
  });

  test("assistant-only recency after child idle does not reactivate the child", async () => {
    addSession("root");
    addSession("child", "root");
    addMessage("child", "child-assistant", "assistant", now - 1_000);
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 3_000) +
        status("child", "session.idle", "stopped", now - 2_000),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("stopped");
    await expect(backend.getSubagents(project)).resolves.toMatchObject([
      { agentId: "child", isActive: false },
    ]);
  });

  test.each([
    ["error", "session.error", "error"],
    ["closed", "session.deleted", "closed"],
  ] as const)("root %s remains authoritative over an active persisted child generation", async (_name, event, state) => {
    addSession("root");
    addSession("child", "root");
    addMessage("child", `child-user-${state}`, "user", now - 1_500);
    const backend = backendForStatus(
      status("root", event, state, now - 2_000) +
        status("child", "session.idle", "stopped", now - 2_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      state,
    );
  });

  test("missing message storage preserves graph-only child fallback", async () => {
    addSession("root");
    addSession("child", "root", false, now - 1_000);
    run(db, "DROP TABLE message");
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 3_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test.each([
    ["equal", now - 4_000],
    ["older", now - 5_000],
  ])("a %s root user message does not reactivate an error", async (_name, userMessageAt) => {
    addSession("root", null, false, now - 1_000);
    const errorAt = now - 4_000;
    addMessage("root", `root-user-${userMessageAt}`, "user", userMessageAt);
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("error");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(errorAt).toISOString(),
    );
  });

  test("an equal-timestamp status reactivation does not recover an error", async () => {
    addSession("root");
    const errorAt = now - 4_000;
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        status("root", "chat.message", "running", errorAt),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "error",
    );
  });

  test("generic root and descendant activity cannot recover or inflate an error", async () => {
    const errorAt = now - 5_000;
    addSession("root", null, false, now - 1_000);
    addSession("child", "root", false, now - 500);
    addMessage("root", "root-assistant", "assistant", now - 500);
    addMessage("child", "child-user", "user", now - 400);
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "root-tool",
        "root-assistant",
        "root",
        now - 500,
        now - 300,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          state: { status: "completed" },
        }),
      ],
    );
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        status("root", "tool.execute.heartbeat", "running", now - 200) +
        status("child", "chat.message", "running", now - 100),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("error");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(errorAt).toISOString(),
    );
  });

  test("closed remains authoritative despite newer root user evidence", async () => {
    addSession("root");
    const closedAt = now - 4_000;
    addMessage("root", "root-user", "user", now - 2_000);
    const backend = backendForStatus(
      status("root", "session.deleted", "closed", closedAt),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("closed");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(closedAt).toISOString(),
    );
  });

  test("a SQLite-recovered root accepts only later-generation blockers and errors", async () => {
    addSession("root");
    addSession("child", "root");
    const errorAt = now - 6_000;
    const userMessageAt = now - 4_000;
    addMessage("root", "root-user", "user", userMessageAt);
    const waitingBackend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        status(
          "root",
          "question.asked",
          "waiting_for_permission",
          now - 5_000,
          "late",
          "question",
        ) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 2_000,
          "fresh",
          "permission",
        ),
    );

    const waitingProject = await projectFor(waitingBackend);
    await expect(waitingBackend.resolveState(waitingProject)).resolves.toBe(
      "waiting_for_permission",
    );
    await expect(
      waitingBackend.computeLastUpdated(waitingProject),
    ).resolves.toBe(new Date(now - 2_000).toISOString());

    const laterErrorAt = now - 1_000;
    const errorBackend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        status("root", "session.error", "error", laterErrorAt),
    );

    await expect(
      errorBackend.resolveState(await projectFor(errorBackend)),
    ).resolves.toBe("error");
    await expect(
      errorBackend.computeLastUpdated(await projectFor(errorBackend)),
    ).resolves.toBe(new Date(laterErrorAt).toISOString());
  });

  test("a SQLite-recovered root ignores descendant blockers from before its new generation", async () => {
    addSession("root");
    addSession("child", "root");
    const errorAt = now - 6_000;
    const userMessageAt = now - 4_000;
    addMessage("root", "root-user", "user", userMessageAt);
    const oldBlocker = status(
      "child",
      "permission.asked",
      "waiting_for_permission",
      now - 5_000,
      "old",
      "permission",
    );
    const oldBlockerBackend = backendForStatus(
      status("root", "session.error", "error", errorAt) + oldBlocker,
    );

    await expect(
      oldBlockerBackend.resolveState(await projectFor(oldBlockerBackend)),
    ).resolves.toBe("running");

    const freshBlockerBackend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        oldBlocker +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 2_000,
          "fresh",
          "permission",
        ),
    );

    await expect(
      freshBlockerBackend.resolveState(await projectFor(freshBlockerBackend)),
    ).resolves.toBe("waiting_for_permission");
  });

  test("a recovered root keeps its descendant cutoff after becoming idle", async () => {
    addSession("root");
    addSession("child", "root");
    const errorAt = now - 6_000;
    const userMessageAt = now - 4_000;
    addMessage("root", "root-user", "user", userMessageAt);
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 5_000,
          "old",
          "permission",
        ) +
        status("root", "session.idle", "stopped", now - 2_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "stopped",
    );
  });

  test("a stale recovered root excludes direct-child liveness from before recovery", async () => {
    addSession("root", null, false, now - 10 * 60_000);
    addSession("child", "root", false, now - 10 * 60_000);
    const errorAt = now - 70_000;
    // A fresh (<=30s) user message recovers the stale root; a >30s one no
    // longer does (the approved Q4 windowing behavior change).
    const userMessageAt = now - 25_000;
    addMessage("root", "root-user", "user", userMessageAt);
    // The child's running liveness predates the recovery, so it is excluded.
    // The root then goes idle after the recovery, ending "stopped".
    const backend = backendForStatus(
      `${JSON.stringify({
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date(now - 5_000).toISOString(),
        active_sessions: 0,
      })}\n` +
        status("root", "session.error", "error", errorAt) +
        status("child", "UserPromptSubmit", "running", now - 35_000) +
        status("root", "session.idle", "stopped", now - 5_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "stopped",
    );
  });

  test("a stale (>30s) persisted user message no longer re-activates a hard-terminal session (R1.1)", async () => {
    addSession("root-a");
    addSession("root-b");
    const errorAt = now - 70_000;
    // root-a: user message >30s old (stale) → excluded by the
    // root_user_messages windowing → latestUserMessageMs is null → the
    // hard-terminal session stays "error" (not re-activated).
    addMessage("root-a", "root-a-user", "user", now - 40_000);
    // root-b (contrast): user message <30s old (fresh) → included → the
    // hard-terminal session is re-activated to "running". Pinning both sides
    // of the 30s boundary makes this test sensitive to the windowing cutoff.
    addMessage("root-b", "root-b-user", "user", now - 25_000);
    // No heartbeat → plugin unhealthy → the windowed CTEs actually run.
    const backend = backendForStatus(
      status("root-a", "session.error", "error", errorAt) +
        status("root-b", "session.error", "error", errorAt),
    );

    await expect(
      backend.resolveState(await projectFor(backend, "root-a")),
    ).resolves.toBe("error");
    await expect(
      backend.resolveState(await projectFor(backend, "root-b")),
    ).resolves.toBe("running");
  });

  test("a root without recovered terminal state retains descendant blocker state", async () => {
    addSession("root");
    addSession("child", "root");
    addMessage("root", "root-user", "user", now - 1_000);
    const backend = backendForStatus(
      status(
        "child",
        "question.asked",
        "waiting_for_permission",
        now - 2_000,
        "active",
        "question",
      ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("retries persisted user evidence after the message table schema changes", async () => {
    addSession("root");
    const errorAt = now - 4_000;
    run(db, "DROP TABLE message");
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "error",
    );

    run(
      db,
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    addMessage("root", "root-user", "user", now - 2_000);

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("detects a message table created while handling a missing-table query", async () => {
    addSession("root");
    run(db, "DROP TABLE message");
    const errorAt = now - 4_000;
    const userMessageAt = now - 2_000;
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt),
    );
    const originalPrepare = db.prepare.bind(db);
    let injectedTableCreation = false;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (
        !injectedTableCreation &&
        sql.includes("WITH RECURSIVE forest") &&
        sql.includes("root_user_messages")
      ) {
        injectedTableCreation = true;
        originalPrepare(
          "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
        ).run();
        originalPrepare(
          "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
          "root-user",
          "root",
          userMessageAt,
          userMessageAt,
          JSON.stringify({ role: "user" }),
        );
        throw new Error("no such table: message");
      }
      return originalPrepare(sql);
    });

    try {
      await expect(
        backend.resolveState(await projectFor(backend)),
      ).resolves.toBe("running");
    } finally {
      prepareSpy.mockRestore();
    }
  });

  test("retries when the message table appears after the post-failure existence check", async () => {
    addSession("root");
    run(db, "DROP TABLE message");
    const errorAt = now - 4_000;
    const userMessageAt = now - 2_000;
    const backend = backendForStatus(
      status("root", "session.error", "error", errorAt),
    );
    const originalPrepare = db.prepare.bind(db);
    let injectedTableCreation = false;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (
        injectedTableCreation ||
        !sql.includes("SELECT 1 FROM sqlite_master")
      ) {
        return statement;
      }

      return {
        get: () => {
          const result = statement.get();
          injectedTableCreation = true;
          originalPrepare(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
          ).run();
          originalPrepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
          ).run(
            "root-user",
            "root",
            userMessageAt,
            userMessageAt,
            JSON.stringify({ role: "user" }),
          );
          return result;
        },
      } as typeof statement;
    });

    try {
      await expect(
        backend.resolveState(await projectFor(backend)),
      ).resolves.toBe("error");
      await expect(
        backend.resolveState(await projectFor(backend)),
      ).resolves.toBe("running");
    } finally {
      prepareSpy.mockRestore();
    }
  });

  test("normalizes empty request IDs to the legacy blocker slot", async () => {
    addSession("root");
    addSession("child", "root");
    const emptyIdAsk = JSON.stringify({
      event: "permission.asked",
      state: "waiting_for_permission",
      timestamp: new Date(now - 2_000).toISOString(),
      session_id: "child",
      working_dir: "/home/user/blockers",
      request_id: "",
    });
    const backend = backendForStatus(
      `${emptyIdAsk}\n${status("child", "permission.replied", "running", now - 1_000)}`,
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("permission.rejected resolves matching permission activity", async () => {
    addSession("root");
    const rejectedAt = now - 1_000;
    const backend = backendForStatus(
      status(
        "root",
        "permission.asked",
        "waiting_for_permission",
        now - 2_000,
        "permission",
        "permission",
      ) +
        status(
          "root",
          "permission.rejected",
          "running",
          rejectedAt,
          "permission",
          "permission",
        ),
    );
    const project = await projectFor(backend);

    await expect(backend.resolveState(project)).resolves.toBe("running");
    await expect(backend.computeLastUpdated(project)).resolves.toBe(
      new Date(rejectedAt).toISOString(),
    );
  });

  test("idle ignores late tool and blocker lifecycle evidence until chat reactivates it", async () => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 5_000) +
        status("root", "tool.execute.after", "running", now - 4_000) +
        status(
          "root",
          "question.asked",
          "waiting_for_permission",
          now - 3_000,
          "late",
          "question",
        ) +
        status("root", "chat.message", "running", now - 2_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("session.created resets a reused idle child generation before a fresh blocker", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("child", "session.idle", "stopped", now - 4_000) +
        status("child", "session.created", "running", now - 3_000) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 2_000,
          "fresh",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("a fresh descendant blocker promotes an idle root to waiting", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 3_000) +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 1_000,
          "child-question",
          "question",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test.each([
    ["session.error", "error"],
    ["session.deleted", "closed"],
  ] as const)("%s crosses an idle root into the hard terminal state", async (event, state) => {
    addSession("root");
    const backend = backendForStatus(
      status("root", "session.idle", "stopped", now - 2_000) +
        status("root", event, state, now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      state,
    );
  });

  test("raw UserPromptSubmit starts a new blocker generation", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status(
        "child",
        "PermissionRequest",
        "waiting_for_permission",
        now - 4_000,
      ) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 3_000,
          "request-aware",
          "permission",
        ) +
        status(
          "child",
          "question.asked",
          "waiting_for_permission",
          now - 2_000,
          "question-aware",
          "question",
        ) +
        status("child", "UserPromptSubmit", "running", now - 1_000),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "running",
    );
  });

  test("a reactivated generation can block only on a new ask", async () => {
    addSession("root");
    addSession("child", "root");
    const backend = backendForStatus(
      status(
        "child",
        "question.asked",
        "waiting_for_permission",
        now - 3_000,
        "old-question",
        "question",
      ) +
        status("child", "chat.message", "running", now - 2_000) +
        status(
          "child",
          "permission.asked",
          "waiting_for_permission",
          now - 1_000,
          "new-permission",
          "permission",
        ),
    );

    await expect(backend.resolveState(await projectFor(backend))).resolves.toBe(
      "waiting_for_permission",
    );
  });

  test("uses one collection query for forest and persisted user evidence", async () => {
    addSession("root");
    addSession("child-a", "root");
    addSession("child-b", "child-a");
    addSession("child-c", "child-b");
    addSession("other-root");
    addSession("other-child", "other-root");
    addMessage("root", "root-user", "user", now - 1_000);
    addMessage("child-c", "child-user", "user", now - 1_000);
    addMessage("other-root", "other-user", "user", now - 1_000);
    for (let index = 0; index < 32; index += 1) {
      const sessionId = `deep-child-${index}`;
      addSession(sessionId, index === 0 ? "root" : `deep-child-${index - 1}`);
      addMessage(sessionId, `deep-child-user-${index}`, "user", now - 1_000);
    }
    // No heartbeat, so the plugin is unhealthy and the JSON CTEs are always
    // needed: the forest and persisted user evidence are collected in a single
    // query.
    const backend = backendForStatus(
      status("root", "chat.message", "running", now - 2_000) +
        status("child-a", "chat.message", "running", now - 2_000) +
        status("child-b", "chat.message", "running", now - 2_000) +
        status("child-c", "chat.message", "running", now - 2_000) +
        status("other-root", "chat.message", "running", now - 2_000) +
        status("other-child", "chat.message", "running", now - 2_000),
    );
    const prepareSpy = vi.spyOn(db, "prepare");

    const projects = await backend.scanProjects();
    for (const project of projects) {
      await backend.resolveState(project);
      await backend.computeLastUpdated(project);
      await backend.getSubagents(project);
    }

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy.mock.calls[0][0]).toContain("WITH RECURSIVE forest");
  });

  test("uses the parent_id index for recursive child expansion", () => {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM session WHERE parent_id = ?")
      .all("root") as { detail: string }[];

    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "session_parent_id_idx",
    );
  });

  test("rejects an index where parent_id is not the leading key", () => {
    const unindexedDb = new DatabaseSync(":memory:");
    run(unindexedDb, "CREATE TABLE session (id TEXT, parent_id TEXT)");
    run(
      unindexedDb,
      "CREATE INDEX session_id_parent_idx ON session(id, parent_id)",
    );

    expect(() => new OpencodeBackend(unindexedDb)).toThrow(
      "requires an index on parent_id",
    );
  });
});

describe("OpencodeBackend — inference gate (T3)", () => {
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-inference-gate-"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function addSession(
    id: string,
    parentId: string | null = null,
    archived = false,
    updated = now - 10 * 60_000,
  ): void {
    run(db, "INSERT OR IGNORE INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-gate",
      "gate",
      "/home/user/gate",
    ]);
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        id,
        "/home/user/gate",
        updated - 1_000,
        updated,
        archived ? updated : null,
        parentId,
        "proj-gate",
      ],
    );
  }

  function addMessage(
    sessionId: string,
    id: string,
    role: "assistant" | "user",
    createdAt: number,
    updatedAt = createdAt,
  ): void {
    run(
      db,
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [id, sessionId, createdAt, updatedAt, JSON.stringify({ role })],
    );
  }

  function addPart(
    sessionId: string,
    messageId: string,
    id: string,
    updatedAt: number,
    data: Record<string, unknown>,
  ): void {
    run(
      db,
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id,
        messageId,
        sessionId,
        updatedAt - 1_000,
        updatedAt,
        JSON.stringify(data),
      ],
    );
  }

  function status(
    sessionId: string,
    event: string,
    state: SessionState,
    timestamp = now - 1_000,
  ): string {
    return `${JSON.stringify({
      event,
      state,
      timestamp: new Date(timestamp).toISOString(),
      session_id: sessionId,
      working_dir: "/home/user/gate",
    })}\n`;
  }

  function heartbeatLine(timestamp: number, activeSessions = 0): string {
    return `${JSON.stringify({
      event: "plugin.heartbeat",
      state: "running",
      timestamp: new Date(timestamp).toISOString(),
      active_sessions: activeSessions,
    })}\n`;
  }

  function backendForStatus(contents: string): OpencodeBackend {
    const statusPath = join(tmpDir, "opencode-status.jsonl");
    writeFileSync(statusPath, contents);
    return new OpencodeBackend(db, 5_000, statusPath);
  }

  async function projectFor(backend: OpencodeBackend, sessionId: string) {
    const project = (await backend.scanProjects()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!project) throw new Error(`missing visible root ${sessionId}`);
    return project;
  }

  function executedForestQueries(prepareSpy: {
    mock: { calls: unknown[][] };
  }): string[] {
    return prepareSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .filter((sql: string) => sql.includes("WITH RECURSIVE forest"));
  }

  test("AC1: fresh heartbeat + all-fresh sessions → no json_extract in the forest SQL", async () => {
    const prepareSpy = vi.spyOn(db, "prepare");
    addSession("root");
    addSession("child", "root");
    addMessage("root", "root-user", "user", now - 1_000);
    const backend = backendForStatus(
      heartbeatLine(now - 5_000) +
        status("root", "chat.message", "running", now - 2_000) +
        status("child", "chat.message", "running", now - 2_000),
    );
    await backend.resolveState(await projectFor(backend, "root"));

    const forestQueries = executedForestQueries(prepareSpy);
    expect(forestQueries.length).toBeGreaterThan(0);
    for (const sql of forestQueries) {
      expect(sql).not.toContain("json_extract");
    }
  });

  test("AC2: no heartbeat → both windowed CTEs run; only fresh (<30s) activity reported", async () => {
    const prepareSpy = vi.spyOn(db, "prepare");
    addSession("root");
    addMessage("root", "root-user", "user", now - 1_000);
    addPart("root", "msg-fresh", "part-fresh", now - 10_000, {
      type: "tool",
      state: "pending",
    });
    addPart("root", "msg-stale", "part-stale", now - 60_000, {
      type: "tool",
      state: "pending",
    });
    const backend = backendForStatus(""); // no heartbeat → plugin unhealthy
    const state = await backend.resolveState(await projectFor(backend, "root"));

    const withCtes = executedForestQueries(prepareSpy).find((sql) =>
      sql.includes("json_extract"),
    );
    expect(withCtes).toBeDefined();
    expect(withCtes).toContain("root_user_messages");
    expect(withCtes).toContain("sqlite_activity");
    // Both sqlite_activity branches are windowed to the 30s cutoff, so the
    // stale part (now-60s) and any stale message row are excluded at the SQL
    // level (not just the JS-side isFreshSqliteActivity gate).
    expect(withCtes).toContain("p.time_updated > ?");
    expect(withCtes).toContain("m.time_updated > ?");
    // The fresh part (now-10s) drives running; the stale part (now-60s) is
    // windowed out, so it does not affect the outcome.
    expect(state).toBe("running");
  });

  test("AC3: plugin healthy → CTEs session-filtered; A inferred running, B authoritative stopped", async () => {
    const prepareSpy = vi.spyOn(db, "prepare");
    addSession("root-a");
    addSession("root-b");
    // Session A: no plugin events but a fresh pending part → inference needed.
    addPart("root-a", "msg-a", "part-a", now - 10_000, {
      type: "tool",
      state: "pending",
    });
    const backend = backendForStatus(
      heartbeatLine(now - 5_000) +
        status("root-b", "Stop", "stopped", now - 10_000),
    );
    const stateA = await backend.resolveState(
      await projectFor(backend, "root-a"),
    );
    const stateB = await backend.resolveState(
      await projectFor(backend, "root-b"),
    );

    expect(stateA).toBe("running");
    expect(stateB).toBe("stopped");
    // The CTEs run only for session A (B has fresh plugin evidence), so the
    // IN clause carries exactly one placeholder (A's id) rather than a
    // full-table or multi-session CTE.
    const cteSql = executedForestQueries(prepareSpy).find((sql) =>
      sql.includes("json_extract"),
    );
    expect(cteSql).toBeDefined();
    const inClause = cteSql?.match(/forest\.session_id IN \(([^)]*)\)/);
    expect(inClause).not.toBeNull();
    expect(inClause?.[1].split(",").length).toBe(1);
  });

  test("T2 AC3: heartbeat ≥ 90s old → plugin unhealthy, CTEs present", async () => {
    const prepareSpy = vi.spyOn(db, "prepare");
    addSession("root");
    addPart("root", "msg-x", "part-x", now - 10_000, {
      type: "tool",
      state: "pending",
    });
    // A heartbeat 100s old is beyond the 90s PLUGIN_HEALTH_THRESHOLD_MS, so
    // the plugin is treated as unhealthy and the JSON CTEs run.
    const backend = backendForStatus(heartbeatLine(now - 100_000, 1));
    await backend.resolveState(await projectFor(backend, "root"));

    const withCtes = executedForestQueries(prepareSpy).find((sql) =>
      sql.includes("json_extract"),
    );
    expect(withCtes).toBeDefined();
    expect(withCtes).toContain("root_user_messages");
    expect(withCtes).toContain("sqlite_activity");
  });
});

describe("OpencodeBackend — change-aware status poll (T4)", () => {
  let db: DB;
  let tmpDir: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), "ccmon-change-aware-"));
  });

  function makeBackend(
    statusPollIntervalMs = 50,
    pollIntervalMs = 50,
  ): OpencodeBackend {
    return new OpencodeBackend(
      db,
      pollIntervalMs,
      join(tmpDir, "status.jsonl"),
      statusPollIntervalMs,
    );
  }

  test("AC1: unchanged file → 0 onUpdate calls across ≥2 poll intervals", async () => {
    const statusPath = join(tmpDir, "status.jsonl");
    writeFileSync(statusPath, "");
    const backend = makeBackend(50, 50);
    let calls = 0;
    const { stop } = backend.watchForChanges(() => {
      calls += 1;
    });
    // Wait across ≥2 poll intervals (2 × 50ms) with no file changes.
    await new Promise((r) => setTimeout(r, 180));
    stop();
    expect(calls).toBe(0);
  }, 3000);

  test("AC2: appending 1 byte → onUpdate fires within one poll interval", async () => {
    const statusPath = join(tmpDir, "status.jsonl");
    writeFileSync(statusPath, "x");
    const backend = makeBackend(50, 50);
    let calls = 0;
    const { stop } = backend.watchForChanges(() => {
      calls += 1;
    });
    // Append a byte after the baseline is captured.
    await new Promise((r) => setTimeout(r, 30));
    const existing = readFileSync(statusPath, "utf-8");
    writeFileSync(statusPath, `${existing}y`);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(calls).toBeGreaterThanOrEqual(1);
  }, 3000);

  test("AC3: deleting the file → poll falls back to unconditional cadence", async () => {
    const statusPath = join(tmpDir, "status.jsonl");
    writeFileSync(statusPath, "x");
    const backend = makeBackend(50, 50);
    let calls = 0;
    const { stop } = backend.watchForChanges(() => {
      calls += 1;
    });
    // Delete the file; the change-aware poll should fall back to the
    // unconditional poll (50ms here), which fires onUpdate every tick.
    unlinkSync(statusPath);
    await new Promise((r) => setTimeout(r, 180));
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 3000);
});
