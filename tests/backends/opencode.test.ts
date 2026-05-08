import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { OpencodeBackend } from "../../src/backends/opencode";
import type { BackendSource } from "../../src/sessions";

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
      latestJSONL: "",
      source: "opencode" as BackendSource,
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
    const state = await backend.buildProjectState(project);

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
    const state = await backend.buildProjectState(project);
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
    const state = await backend.buildProjectState(project);

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
    // Stale child (time_updated = 20s ago → isActive = false, but within 30s expiry)
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
    expect(stale?.isActive).toBe(false);
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

  test("excludes stale sub-agents older than 30s that are not active", async () => {
    const now = Date.now();
    const parentId = setupParent();

    // Very old child (>30s, not active → should be excluded)
    run(
      db,
      "INSERT INTO session (id, title, directory, time_created, time_updated, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_child_expired",
        "Expired",
        "/home/user/parentproj",
        now - 60000,
        now - 60000,
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
    const state = await backend.buildProjectState(project);

    expect(state.subagents).toBeDefined();
    expect(state.subagents?.length).toBe(1);
    expect(state.subagentCount).toBe(1);
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

  test("resolveState returns stopped when parent and all children are stale", async () => {
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
        "ses_child_stale_state",
        "Stale Child",
        "/home/user/parentproj",
        now - 120000,
        now - 60000,
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
    const state = await backend.buildProjectState(project);
    expect(state.lastUpdated).toBe(new Date(childUpdated).toISOString());
  });

  test("buildProjectState lastUpdated uses parent time_updated when parent is more recent", async () => {
    const now = Date.now();
    const parentId = setupParent();

    const parentUpdated = now;

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
    const state = await backend.buildProjectState(project);
    expect(state.lastUpdated).toBe(new Date(parentUpdated).toISOString());
  });
});

describe("OpencodeBackend — polling", () => {
  let db: DB;
  let backend: OpencodeBackend;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    createSchema(db);
    backend = new OpencodeBackend(db, 50); // short poll interval for tests
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

    expect(state).toBe("stopped");
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
});
