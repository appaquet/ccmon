import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeBackend } from "../src/backends/claude";
import { OpencodeBackend } from "../src/backends/opencode";
import { startServer } from "../src/server";
import { replaceDefaultStore, SessionStore } from "../src/sessions";
import { makeTempDir } from "./_helpers";

describe("integration — both backends", () => {
  let tmpDir: string;
  let claudeDir: string;
  let opencodeDB: Database;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-integration");

    // Set up Claude Code directory
    claudeDir = join(tmpDir, "claude-projects");
    await mkdir(claudeDir, { recursive: true });

    replaceDefaultStore(new SessionStore(tmpDir));

    const projDir = join(claudeDir, "-home-user-claude-proj");
    await mkdir(projDir, { recursive: true });
    const firstLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: "claude-session-1",
      cwd: "/home/user/claude-proj",
    });
    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    // Set up OpenCode in-memory DB
    opencodeDB = new Database(":memory:");
    opencodeDB.run(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        name TEXT,
        root TEXT
      )
    `);
    opencodeDB.run(`
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
    `);
    const now = Date.now();
    opencodeDB.run("INSERT INTO project (id, name, root) VALUES (?, ?, ?)", [
      "proj-oc",
      "opencode-proj",
      "/home/user/opencode-proj",
    ]);
    opencodeDB.run(
      "INSERT INTO session (id, title, directory, time_created, time_updated, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "ses_oc_1",
        "OpenCode Session",
        "/home/user/opencode-proj",
        now - 60000,
        now,
        "proj-oc",
      ],
    );
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    opencodeDB?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dump output includes projects from both backends", async () => {
    const claudeBackend = new ClaudeBackend(claudeDir);
    const opencodeBackend = new OpencodeBackend(opencodeDB);

    const claudeProjects = await claudeBackend.scanProjects();
    const opencodeProjects = await opencodeBackend.scanProjects();

    expect(claudeProjects).toHaveLength(1);
    expect(claudeProjects[0].projectName).toBe("claude-proj");
    expect(claudeProjects[0].source).toBe("claude");

    expect(opencodeProjects).toHaveLength(1);
    expect(opencodeProjects[0].projectName).toBe("opencode-proj");
    expect(opencodeProjects[0].source).toBe("opencode");
  });

  test("buildProjectState includes source field for both backends", async () => {
    const claudeBackend = new ClaudeBackend(claudeDir);
    const opencodeBackend = new OpencodeBackend(opencodeDB);

    const claudeProjects = await claudeBackend.scanProjects();
    const claudeState = await claudeBackend.buildProjectState(
      claudeProjects[0],
    );
    expect(claudeState.source).toBe("claude");

    const opencodeProjects = await opencodeBackend.scanProjects();
    const opencodeState = await opencodeBackend.buildProjectState(
      opencodeProjects[0],
    );
    expect(opencodeState.source).toBe("opencode");
  });

  test("server WS broadcasts include projects from both backends", async () => {
    const claudeBackend = new ClaudeBackend(claudeDir);
    const opencodeBackend = new OpencodeBackend(opencodeDB);

    const srv = startServer({
      port: 0,
      backends: [claudeBackend, opencodeBackend],
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
      projects: Array<Record<string, unknown>>;
    };
    const projects = envelope.projects;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBe(2);

    const sources = projects.map((p) => p.source);
    expect(sources).toContain("claude");
    expect(sources).toContain("opencode");

    const names = projects.map((p) => p.projectName);
    expect(names).toContain("claude-proj");
    expect(names).toContain("opencode-proj");
  });

  test("projectKey produces unique keys across backends", () => {
    const claudeBackend = new ClaudeBackend(claudeDir);
    const opencodeBackend = new OpencodeBackend(opencodeDB);

    const claudeKey = claudeBackend.projectKey({
      projectDir: "-home-user-a",
      cwd: "/home/user/a",
      projectName: "a",
      sessionId: "sid-a",
      latestJSONL: "",
      source: "claude",
    });

    const opencodeKey = opencodeBackend.projectKey({
      projectDir: "/home/user/b",
      cwd: "/home/user/b",
      projectName: "b",
      sessionId: "ses_b",
      latestJSONL: "",
      source: "opencode",
    });

    expect(claudeKey).not.toBe(opencodeKey);
    expect(claudeKey).toContain("/claude-projects/");
    expect(opencodeKey).toContain("opencode::");
  });
});
