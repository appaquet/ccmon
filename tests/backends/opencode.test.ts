import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { buildProjectState } from "../../src/backends/build-project-state.ts";
import { OpencodeBackend } from "../../src/backends/opencode.ts";
import {
  STATUS_LOG_TAIL_BYTES,
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

  test("scanProjects returns only the latest session per directory", async () => {
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
    expect(projects).toHaveLength(1);
    expect(projects[0].sessionId).toBe("ses_new");
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
    expect(projects).toHaveLength(2);
    const ids = projects.map((p) => p.sessionId);
    expect(ids).toContain("ses_a2");
    expect(ids).toContain("ses_b");
    expect(ids).not.toContain("ses_a1");
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

  test("resolveState returns running via fallback directory scan when parent_id linkage is absent", async () => {
    const now = Date.now();
    const parentId = setupParent();

    run(db, "UPDATE session SET time_updated = ? WHERE id = ?", [
      now - 60000,
      parentId,
    ]);

    // Child session without parent_id — simulates missing linkage
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_unlinked_child",
        "Unlinked Child",
        "/home/user/parentproj",
        now - 10000,
        now,
        "proj-parent",
      ],
    );

    const project = (await backend.scanProjects())[0];
    const state = await backend.resolveState(project);
    expect(state).toBe("running");
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

  test("buildProjectState lastUpdated uses child time_updated when child is more recent", async () => {
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
    expect(state.lastUpdated).toBe(new Date(childUpdated).toISOString());
  });

  test("buildProjectState lastUpdated uses same-directory unlinked active child time_updated", async () => {
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
    expect(state.state).toBe("running");
    expect(state.lastUpdated).toBe(new Date(childUpdated).toISOString());
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

  test("cache is invalidated when status file mtime changes", async () => {
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

    const state2 = await backend.resolveState(projects[0]);
    expect(state2).toBe("stopped");
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

  test("active same-directory unlinked child keeps parent running after parent idle status", async () => {
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
        "ses_active_unlinked_child",
        "Active unlinked child",
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
    await expect(backend.resolveState(projects[0])).resolves.toBe("running");
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

  test("background polling fires alongside fs.watch at statusPollIntervalMs", async () => {
    const backend = new OpencodeBackend(db, 5000, statusPath, 50);

    const calls: number[] = [];
    const { stop } = backend.watchForChanges(() => {
      calls.push(Date.now());
    });

    // Wait for multiple polling cycles at 50ms
    await new Promise((r) => setTimeout(r, 250));
    stop();

    // Background polling fires every ~50ms → should get several callbacks
    expect(calls.length).toBeGreaterThanOrEqual(2);
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

    const finalState = await backend.resolveState(projects[0]);
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

    const updatedSubs = await backend.getSubagents(projects[0]);
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

  test("tail-cap falls back to timestamp inference when target session events are all outside the tail", async () => {
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

    // Build a large file: target event at the beginning (before the tail window),
    // then padding so the tail does NOT include the target event
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

    // Target event was before the tail — timestamp inference applies: session is stale → stopped
    expect(state).toBe("stopped");
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
