import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionBackend } from "../src/backends/types.ts";
import {
  buildOutput,
  filterProjectsByName,
  replaceBackendStates,
} from "../src/cli/commands/dump.ts";
import { resolveProjectDir, runStatus } from "../src/cli/commands/status.ts";
import {
  parseNumberFlag,
  parsePortFlag,
  parseStringFlag,
} from "../src/cli/helpers.ts";
import type { ProjectInfo } from "../src/types.ts";
import { makeTempDir } from "./_helpers.ts";

const STATUS_LOG_FILE = "ccmon-status.jsonl";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "cli", "main.ts");
const NODE = process.execPath;

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
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

function makeFirstLine(cwd: string, sessionId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
  });
}

function makeStatusEvent(event = "PostToolUse", state = "running"): string {
  return JSON.stringify({
    event,
    state,
    timestamp: new Date().toISOString(),
    session_id: "test-session",
    working_dir: "/home/user/proj",
  });
}

function largeDumpProjectIdentity(index: number) {
  const suffix = String(index).padStart(3, "0");
  const projectName = `large-dump-${suffix}`;
  return {
    sessionId: `session-${suffix}`,
    cwd: `/home/user/${projectName}`,
    projectName,
  };
}

async function createClaudeDumpFixtures(
  projectsDir: string,
  count: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const project = largeDumpProjectIdentity(index);
      const projectDir = join(projectsDir, `-home-user-${project.projectName}`);
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          timestamp: "2026-07-23T00:00:00.000Z",
          sessionId: project.sessionId,
          cwd: project.cwd,
        })}\n`,
      );
    }),
  );
}

function createOpencodeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      name TEXT,
      root TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER,
      parent_id TEXT,
      project_id TEXT REFERENCES project(id)
    );
    CREATE INDEX session_parent_id_idx ON session(parent_id);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE todo (
      session_id TEXT,
      content TEXT,
      status TEXT,
      priority TEXT,
      position INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    );
  `);
}

function seedOpencodeSiblings(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  createOpencodeSchema(db);
  db.prepare("INSERT INTO project (id, name, root) VALUES (?, ?, ?)").run(
    "proj1",
    "repo",
    "/home/user/repo",
  );
  db.prepare(
    "INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "ses_peer_a",
    null,
    "/home/user/repo",
    now - 2_000,
    now - 2_000,
    null,
    null,
    "proj1",
  );
  db.prepare(
    "INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "ses_peer_b",
    "Feature branch",
    "/home/user/repo",
    now - 1_000,
    now - 1_000,
    null,
    null,
    "proj1",
  );
  db.close();
}

type OpencodeProjectInfo = Extract<ProjectInfo, { source: "opencode" }>;

class TestBackend implements SessionBackend<OpencodeProjectInfo> {
  readonly source = "opencode" as const;
  async scanProjects() {
    return [];
  }
  watchForChanges() {
    return { stop() {} };
  }
  async resolveState() {
    return "running" as const;
  }
  async computeLastUpdated() {
    return new Date(0).toISOString();
  }
  async enrichProject() {
    return {};
  }
  async getSubagents() {
    return [];
  }
  projectKey(project: OpencodeProjectInfo): string {
    return `${project.source}::${project.sessionId}`;
  }
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
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, [CLI_PATH, ...args], {
      stdio: "pipe",
      env: { ...process.env, ...options.env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
    proc.stdin.end(options.stdin);
  });
}

async function waitForJsonBlocks(
  chunks: Buffer[],
  minimum: number,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      splitJsonBlocks(Buffer.concat(chunks).toString("utf-8")).length >= minimum
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} JSON output blocks`);
}

// ─── parseNumberFlag ─────────────────────────────────────────────────────────

describe("parseNumberFlag", () => {
  test("parses a plain integer", () => {
    expect(parseNumberFlag(["--max-age", "5"], "--max-age")).toBe(5);
  });

  test("parses a float", () => {
    expect(parseNumberFlag(["--max-age", "3.5"], "--max-age")).toBe(3.5);
  });

  test("rejects trailing garbage like '3.5abc'", () => {
    expect(
      parseNumberFlag(["--max-age", "3.5abc"], "--max-age"),
    ).toBeUndefined();
  });

  test("rejects '8080abc'", () => {
    expect(
      parseNumberFlag(["--max-age", "8080abc"], "--max-age"),
    ).toBeUndefined();
  });

  test("returns undefined when flag is absent", () => {
    expect(parseNumberFlag([], "--max-age")).toBeUndefined();
  });
});

describe("parseStringFlag", () => {
  test("rejects a following option as a missing value", () => {
    expect(parseStringFlag(["--host", "--port", "9000"], "--host")).toBe(null);
  });
});

// ─── parsePortFlag ────────────────────────────────────────────────────────────

describe("parsePortFlag", () => {
  test("accepts a valid port like 8080", () => {
    expect(parsePortFlag(["--port", "8080"], "--port")).toBe(8080);
  });

  test("accepts boundary port 1", () => {
    expect(parsePortFlag(["--port", "1"], "--port")).toBe(1);
  });

  test("accepts boundary port 65535", () => {
    expect(parsePortFlag(["--port", "65535"], "--port")).toBe(65535);
  });

  test("rejects port -1", () => {
    expect(parsePortFlag(["--port", "-1"], "--port")).toBeUndefined();
  });

  test("rejects port 0", () => {
    expect(parsePortFlag(["--port", "0"], "--port")).toBeUndefined();
  });

  test("rejects port 65536", () => {
    expect(parsePortFlag(["--port", "65536"], "--port")).toBeUndefined();
  });

  test("rejects fractional port 3.5", () => {
    expect(parsePortFlag(["--port", "3.5"], "--port")).toBeUndefined();
  });

  test("returns undefined when flag is absent", () => {
    expect(parsePortFlag([], "--port")).toBeUndefined();
  });
});

// ─── resolveProjectDir (unit) ────────────────────────────────────────────────

describe("resolveProjectDir", () => {
  test("exact cwd match returns joined path", () => {
    const projects = [
      { cwd: "/home/user/proj", projectDir: "-home-user-proj" },
    ];
    expect(resolveProjectDir("/home/user/proj", "/base", projects)).toBe(
      "/base/-home-user-proj",
    );
  });

  test("subdirectory cwd matches parent project", () => {
    const projects = [
      { cwd: "/home/user/proj", projectDir: "-home-user-proj" },
    ];
    expect(resolveProjectDir("/home/user/proj/sub", "/base", projects)).toBe(
      "/base/-home-user-proj",
    );
  });

  test("deepest parent wins on ambiguous prefix match", () => {
    const projects = [
      { cwd: "/home/user", projectDir: "-home-user" },
      { cwd: "/home/user/proj", projectDir: "-home-user-proj" },
    ];
    expect(resolveProjectDir("/home/user/proj/deep", "/base", projects)).toBe(
      "/base/-home-user-proj",
    );
  });

  test("no match falls back to encoded cwd", () => {
    expect(resolveProjectDir("/tmp/unknown", "/base", [])).toBe(
      "/base/-tmp-unknown",
    );
  });

  test("fallback matches Claude encoding for dots and underscores", () => {
    expect(resolveProjectDir("/tmp/my.project_name", "/base", [])).toBe(
      "/base/-tmp-my-project-name",
    );
  });

  test("pure: does not create any directory (no side effects)", async () => {
    const tmpDir = await makeTempDir("ccmon-resolve-pure");
    try {
      resolveProjectDir("/tmp/newdir", tmpDir, []);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(tmpDir)).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── runStatus (unit, no subprocess) ─────────────────────────────────────────

describe("runStatus (direct call)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-runstatus-unit");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("Stop event returns exit code 0 and writes status file", async () => {
    const projDir = join(tmpDir, "-home-user-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/proj", "sess-unit")}\n`,
    );

    const payload = JSON.stringify({
      session_id: "sess-unit",
      cwd: "/home/user/proj",
      hook_event_name: "Stop",
    });

    const code = await runStatus(tmpDir, payload);
    expect(code).toBe(0);

    const raw = await readFile(join(projDir, "ccmon-status.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const status = JSON.parse(lines[lines.length - 1]);
    expect(status.event).toBe("Stop");
    expect(status.state).toBe("stopped");
  });

  test("empty input returns exit code 1", async () => {
    const code = await runStatus(tmpDir, "");
    expect(code).toBe(1);
  });

  test("invalid JSON returns exit code 1", async () => {
    const code = await runStatus(tmpDir, "{{not json}}");
    expect(code).toBe(1);
  });

  test("missing required fields returns exit code 1", async () => {
    const code = await runStatus(tmpDir, JSON.stringify({ session_id: "s1" }));
    expect(code).toBe(1);
  });

  test("empty cwd returns exit code 1", async () => {
    const code = await runStatus(
      tmpDir,
      JSON.stringify({ session_id: "s1", cwd: "", hook_event_name: "Stop" }),
    );
    expect(code).toBe(1);
  });

  test("relative cwd returns exit code 1", async () => {
    const code = await runStatus(
      tmpDir,
      JSON.stringify({
        session_id: "s1",
        cwd: "relative/path",
        hook_event_name: "Stop",
      }),
    );
    expect(code).toBe(1);
  });

  test("rejects empty session IDs and non-string optional fields", async () => {
    const invalidPayloads = [
      { session_id: "", cwd: "/tmp/project", hook_event_name: "Stop" },
      {
        session_id: "session",
        cwd: "/tmp/project",
        hook_event_name: "Notification",
        message: {},
      },
      {
        session_id: "session",
        cwd: "/tmp/project",
        hook_event_name: "SubagentStop",
        agent_transcript_path: {},
      },
    ];

    for (const payload of invalidPayloads) {
      await expect(runStatus(tmpDir, JSON.stringify(payload))).resolves.toBe(1);
    }
  });

  test("unknown cwd creates only the encoded fallback dir", async () => {
    const unknownCwd = "/tmp/brand-new-proj";
    const payload = JSON.stringify({
      session_id: "sess-new",
      cwd: unknownCwd,
      hook_event_name: "Stop",
    });

    const code = await runStatus(tmpDir, payload);
    expect(code).toBe(0);

    const expectedDir = join(tmpDir, unknownCwd.replace(/\//g, "-"));
    const raw = await readFile(join(expectedDir, "ccmon-status.jsonl"), "utf8");
    expect(raw.trim().length).toBeGreaterThan(0);
  });
});

// ─── dump ─────────────────────────────────────────────────────────────────────

describe("dump", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-dump");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("outputs JSON array of project states", async () => {
    const projDir = join(tmpDir, "-home-user-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/proj", "sid1")}\n`,
    );

    const configPath = join(tmpDir, "ccmon-config.json");
    await writeFile(
      configPath,
      JSON.stringify({ backends: [{ type: "claude", enabled: true }] }),
    );

    const result = await spawnCli(["dump"], {
      env: {
        CLAUDE_PROJECTS_DIR: tmpDir,
        CCMON_CONFIG: configPath,
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cwd).toBe("/home/user/proj");
  });

  test("drains a large no-filter dump through stdout before exiting", async () => {
    const projectCount = 512;
    const expectedProjects = Array.from({ length: projectCount }, (_, index) =>
      largeDumpProjectIdentity(index),
    );
    await createClaudeDumpFixtures(tmpDir, projectCount);

    const configPath = join(tmpDir, "ccmon-config.json");
    await writeFile(
      configPath,
      JSON.stringify({ backends: [{ type: "claude", enabled: true }] }),
    );

    const result = await spawnCli(["dump", "--no-filter"], {
      env: {
        CLAUDE_PROJECTS_DIR: tmpDir,
        CCMON_CONFIG: configPath,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(projectCount);
    const actualProjects: typeof expectedProjects = parsed.map(
      ({ sessionId, cwd, projectName }: (typeof expectedProjects)[number]) => ({
        sessionId,
        cwd,
        projectName,
      }),
    );
    expect(
      actualProjects.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId)),
    ).toEqual(expectedProjects);
  });
});

// ─── dump --project ───────────────────────────────────────────────────────────

describe("dump --project", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-dump-project");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("outputs array of matching project states for the given projectName", async () => {
    const projDir = join(tmpDir, "-home-user-myapp");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/myapp", "sid1")}\n`,
    );

    // Second project with a different name
    const proj2Dir = join(tmpDir, "-home-user-otherapp");
    await mkdir(proj2Dir, { recursive: true });
    await writeFile(
      join(proj2Dir, "session.jsonl"),
      `${makeFirstLine("/home/user/otherapp", "sid2")}\n`,
    );

    const result = await spawnCli(["dump", "--project", "myapp"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].projectName).toBe("myapp");
    expect(parsed[0].cwd).toBe("/home/user/myapp");
  });

  test("returns all matching visible opencode sibling sessions for the same repo", async () => {
    const dbPath = join(tmpDir, "opencode.db");
    seedOpencodeSiblings(dbPath);

    const configPath = join(tmpDir, "ccmon-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        backends: [
          {
            type: "opencode",
            enabled: true,
            databasePath: dbPath,
            statusLogPath: join(tmpDir, "missing-status.jsonl"),
          },
        ],
        maxInactivityHours: 1,
      }),
    );

    const result = await spawnCli(["dump", "--project", "repo"], {
      env: { CCMON_CONFIG: configPath },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(
      parsed.map((entry: { sessionId: string }) => entry.sessionId),
    ).toEqual(["ses_peer_b", "ses_peer_a"]);
  });

  test("outputs nothing when project name does not exist", async () => {
    const projDir = join(tmpDir, "-home-user-myapp");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/myapp", "sid1")}\n`,
    );

    const result = await spawnCli(["dump", "--project", "nonexistent"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("--project with no value → non-zero exit with stderr message", async () => {
    const result = await spawnCli(["dump", "--project"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--project requires a value");
  });
});

// ─── dump --max-age ───────────────────────────────────────────────────────────

describe("dump --max-age", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-dump-maxage");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("--max-age with no value → non-zero exit with stderr message", async () => {
    const result = await spawnCli(["dump", "--max-age"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--max-age requires a valid number");
  });

  test("--max-age with non-numeric value → non-zero exit with stderr message", async () => {
    const result = await spawnCli(["dump", "--max-age", "notanumber"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--max-age requires a valid number");
  });
});

// ─── dump --watch --project ────────────────────────────────────────────────────

describe("dump --watch --project", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-watch-project");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("initial output is a JSON array for the given project filter", async () => {
    const projDir = join(tmpDir, "-home-user-watchapp");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchapp", "sess-wp")}\n`,
    );

    const proc = spawn(
      NODE,
      [CLI_PATH, "dump", "--watch", "--project", "watchapp"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
      },
    );

    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    await waitForJsonBlocks(stdoutChunks, 1, 8_000);
    proc.kill("SIGINT");

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    await new Promise((r) => proc.once("close", r));

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(blocks[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].projectName).toBe("watchapp");
    expect(parsed[0].cwd).toBe("/home/user/watchapp");
  }, 5000);

  test("each update remains a JSON array after status file changes", async () => {
    const projDir = join(tmpDir, "-home-user-watchapp2");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchapp2", "sess-wp2")}\n`,
    );

    const proc = spawn(
      NODE,
      [CLI_PATH, "dump", "--watch", "--project", "watchapp2"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
      },
    );

    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    await waitForJsonBlocks(stdoutChunks, 1, 8_000);

    // Trigger a file change by touching the session JSONL (appending a line)
    const existingContent = await readFile(
      join(projDir, "session.jsonl"),
      "utf-8",
    );
    await writeFile(
      join(projDir, "session.jsonl"),
      `${existingContent}${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
    );
    await waitForJsonBlocks(stdoutChunks, 2, 8_000);

    proc.kill("SIGINT");
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    await new Promise((r) => proc.once("close", r));

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].projectName).toBe("watchapp2");
    }
  }, 10_000);

  test("emits an explicit empty array when the last filtered match disappears", async () => {
    const projDir = join(tmpDir, "-home-user-watchgone");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchgone", "sess-gone")}
`,
    );

    const proc = spawn(
      NODE,
      [CLI_PATH, "dump", "--watch", "--project", "watchgone"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
      },
    );

    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    await waitForJsonBlocks(stdoutChunks, 1);
    await rm(projDir, { recursive: true, force: true });
    await waitForJsonBlocks(stdoutChunks, 2);

    proc.kill("SIGINT");
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    await new Promise((resolve) => proc.once("close", resolve));

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(blocks[0])).toHaveLength(1);
    expect(JSON.parse(blocks[blocks.length - 1])).toEqual([]);
  }, 5000);
});

describe("dump helpers", () => {
  test("filterProjectsByName returns all matching siblings instead of the first match", () => {
    const projects = [
      {
        cwd: "/repo",
        projectName: "repo",
        sessionId: "ses_a",
        source: "opencode" as const,
        state: "running" as const,
        lastUpdated: new Date(1_000).toISOString(),
      },
      {
        cwd: "/repo",
        projectName: "repo",
        sessionId: "ses_b",
        source: "opencode" as const,
        state: "stopped" as const,
        lastUpdated: new Date(2_000).toISOString(),
      },
    ];

    expect(
      filterProjectsByName(projects, "repo").map(
        (project) => project.sessionId,
      ),
    ).toEqual(["ses_a", "ses_b"]);
  });

  test("replaceBackendStates removes disappeared sibling sessions from the watch map", () => {
    const backend = new TestBackend();
    const projectMap = new Map();
    const backendProjectKeys = new Map<TestBackend, Set<string>>();

    replaceBackendStates(
      projectMap,
      backendProjectKeys,
      backend,
      new Map([
        [
          "opencode::ses_a",
          {
            cwd: "/repo",
            projectName: "repo",
            sessionId: "ses_a",
            source: "opencode",
            state: "running",
            lastUpdated: new Date(1_000).toISOString(),
          },
        ],
        [
          "opencode::ses_b",
          {
            cwd: "/repo",
            projectName: "repo",
            sessionId: "ses_b",
            source: "opencode",
            state: "running",
            lastUpdated: new Date(2_000).toISOString(),
          },
        ],
      ]),
    );
    replaceBackendStates(
      projectMap,
      backendProjectKeys,
      backend,
      new Map([
        [
          "opencode::ses_b",
          {
            cwd: "/repo",
            projectName: "repo",
            sessionId: "ses_b",
            source: "opencode",
            state: "running",
            lastUpdated: new Date(2_000).toISOString(),
          },
        ],
      ]),
    );

    expect([...projectMap.keys()]).toEqual(["opencode::ses_b"]);
  });

  test("buildOutput keeps one-shot filtered no-match silent but watch snapshots explicit", () => {
    const projects = [
      {
        cwd: "/repo",
        projectName: "repo",
        sessionId: "ses_a",
        source: "opencode" as const,
        state: "running" as const,
        lastUpdated: new Date(1_000).toISOString(),
      },
    ];

    expect(buildOutput(projects, 1, "missing", false)).toBe("");
    expect(buildOutput(projects, 1, "missing", true)).toBe("[]");
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe("status", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-status");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("pipe hook JSON → writes correct ccmon-status.jsonl", async () => {
    // Set up a project dir that scanProjects() will find
    const projDir = join(tmpDir, "-home-user-myproject");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/myproject", "sess-abc")}\n`,
    );

    const hookPayload = JSON.stringify({
      session_id: "sess-abc",
      cwd: "/home/user/myproject",
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);

    const raw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const status = JSON.parse(lines[lines.length - 1]);
    expect(status.event).toBe("Stop");
    expect(status.state).toBe("stopped");
    expect(status.session_id).toBe("sess-abc");
    expect(status.working_dir).toBe("/home/user/myproject");
    expect(typeof status.timestamp).toBe("string");
  });

  test("outputs hook response JSON to stdout", async () => {
    const projDir = join(tmpDir, "-home-user-hookproj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/hookproj", "sess-hook")}\n`,
    );

    const hookPayload = JSON.stringify({
      session_id: "sess-hook",
      cwd: "/home/user/hookproj",
      hook_event_name: "PostToolUse",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    // Hook protocol requires a JSON response on stdout
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe("object");
  });

  test("empty stdin → non-zero exit with stderr message", async () => {
    const result = await spawnCli(["status"], {
      stdin: "",
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("invalid JSON stdin → non-zero exit with stderr message", async () => {
    const result = await spawnCli(["status"], {
      stdin: "not valid json {{",
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("empty cwd in hook JSON → non-zero exit with stderr message", async () => {
    const hookPayload = JSON.stringify({
      session_id: "sess-emptycwd",
      cwd: "",
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cwd is empty");
  });

  test("cwd not matching any known project → falls back to encoded path", async () => {
    // No project dirs exist, so scanProjects() returns []. The fallback encodes cwd
    // as a directory name and creates it.
    const unknownCwd = "/tmp/unknown-project";

    const hookPayload = JSON.stringify({
      session_id: "sess-unknown",
      cwd: unknownCwd,
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Should succeed: fallback creates the dir and writes the status file
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe("object");
  });

  test("hook event mapped to all known states", async () => {
    const events: Array<[string, string]> = [
      ["UserPromptSubmit", "running"],
      ["PostToolUse", "running"],
      ["PermissionRequest", "waiting_for_permission"],
      ["Stop", "stopped"],
      ["SessionEnd", "closed"],
    ];

    for (const [eventName, expectedState] of events) {
      const projDir = join(tmpDir, `-home-user-${eventName.toLowerCase()}`);
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, "session.jsonl"),
        `${makeFirstLine(
          `/home/user/${eventName.toLowerCase()}`,
          `sess-${eventName}`,
        )}\n`,
      );

      const hookPayload = JSON.stringify({
        session_id: `sess-${eventName}`,
        cwd: `/home/user/${eventName.toLowerCase()}`,
        hook_event_name: eventName,
      });

      const result = await spawnCli(["status"], {
        stdin: hookPayload,
        env: { CLAUDE_PROJECTS_DIR: tmpDir },
      });

      expect(result.exitCode).toBe(0);
      const raw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      const status = JSON.parse(lines[lines.length - 1]);
      expect(status.event).toBe(eventName);
      expect(status.state).toBe(expectedState);
    }
  });

  test("UserPromptSubmit and PostToolUse write running state", async () => {
    for (const eventName of ["UserPromptSubmit", "PostToolUse"]) {
      const projDir = join(
        tmpDir,
        `-home-user-running-${eventName.toLowerCase()}`,
      );
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, "session.jsonl"),
        `${makeFirstLine(
          `/home/user/running-${eventName.toLowerCase()}`,
          `sess-running-${eventName}`,
        )}\n`,
      );

      const hookPayload = JSON.stringify({
        session_id: `sess-running-${eventName}`,
        cwd: `/home/user/running-${eventName.toLowerCase()}`,
        hook_event_name: eventName,
      });

      const result = await spawnCli(["status"], {
        stdin: hookPayload,
        env: { CLAUDE_PROJECTS_DIR: tmpDir },
      });

      expect(result.exitCode).toBe(0);
      const raw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      const status = JSON.parse(lines[lines.length - 1]);
      expect(status.state).toBe("running");
    }
  });

  test("SessionEnd truncates status log to single line", async () => {
    const projDir = join(tmpDir, "-home-user-sessionend");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/sessionend", "sess-end")}\n`,
    );

    // Write pre-existing events
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n${makeStatusEvent("PermissionRequest", "waiting_for_permission")}\n`,
    );

    const hookPayload = JSON.stringify({
      session_id: "sess-end",
      cwd: "/home/user/sessionend",
      hook_event_name: "SessionEnd",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    const raw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("SessionEnd");
  });

  test("Stop appends to status log (does not truncate)", async () => {
    const projDir = join(tmpDir, "-home-user-stopappend");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/stopappend", "sess-stop")}\n`,
    );

    // Write a pre-existing event
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n`,
    );

    const hookPayload = JSON.stringify({
      session_id: "sess-stop",
      cwd: "/home/user/stopappend",
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    const raw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // Pre-existing event + appended Stop event
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("PostToolUse");
    expect(JSON.parse(lines[1]).event).toBe("Stop");
  });

  test("SubagentStop: writes per-agent ccmon-status.json with stopped state", async () => {
    const projDir = join(tmpDir, "-home-user-subagent");
    await mkdir(projDir, { recursive: true });
    const sessionId = "sess-subagent";
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/subagent", sessionId)}\n`,
    );

    // Write an existing session-level status event
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n`,
    );

    const agentId = "ae89d86";
    const sessionUuid = "session-uuid-1";
    const subagentsDir = join(projDir, sessionUuid, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const agentJsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    await writeFile(agentJsonlPath, '{"type":"user"}\n');

    const hookPayload = JSON.stringify({
      session_id: sessionId,
      cwd: "/home/user/subagent",
      hook_event_name: "SubagentStop",
      agent_id: agentId,
      agent_transcript_path: agentJsonlPath,
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});

    // Per-agent status file written with stopped state (still .json)
    const agentStatusPath = join(
      subagentsDir,
      `agent-${agentId}.ccmon-status.json`,
    );
    const agentRaw = await readFile(agentStatusPath, "utf8");
    const agentStatus = JSON.parse(agentRaw);
    expect(agentStatus.state).toBe("stopped");
    expect(typeof agentStatus.timestamp).toBe("string");
  });

  test("SubagentStop: appends SubagentStop event to session-level ccmon-status.jsonl", async () => {
    const projDir = join(tmpDir, "-home-user-subagent2");
    await mkdir(projDir, { recursive: true });
    const sessionId = "sess-subagent2";
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/subagent2", sessionId)}\n`,
    );

    // Write a session-level status event
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n`,
    );

    const agentId = "bf91e23";
    const sessionUuid = "session-uuid-2";
    const subagentsDir = join(projDir, sessionUuid, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const agentJsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    await writeFile(agentJsonlPath, '{"type":"user"}\n');

    const hookPayload = JSON.stringify({
      session_id: sessionId,
      cwd: "/home/user/subagent2",
      hook_event_name: "SubagentStop",
      agent_id: agentId,
      agent_transcript_path: agentJsonlPath,
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);

    // Session-level log should have the original event + appended SubagentStop event
    const sessionRaw = await readFile(join(projDir, STATUS_LOG_FILE), "utf8");
    const lines = sessionRaw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const lastEvent = JSON.parse(lines[lines.length - 1]);
    expect(lastEvent.event).toBe("SubagentStop");
    expect(lastEvent.state).toBe("stopped");
  });

  test("subdirectory working_dir resolves to parent project dir", async () => {
    // Parent project dir with a JSONL file
    const parentProjDir = join(tmpDir, "-home-user-backend4");
    await mkdir(parentProjDir, { recursive: true });
    await writeFile(
      join(parentProjDir, "session.jsonl"),
      `${makeFirstLine("/home/user/backend4", "sess-parent")}\n`,
    );

    // Hook payload uses a subdirectory cwd that doesn't match any project dir
    const hookPayload = JSON.stringify({
      session_id: "sess-parent",
      cwd: "/home/user/backend4/platform",
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);

    // Status should be written to the parent project dir, not a new encoded dir
    const raw = await readFile(join(parentProjDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const status = JSON.parse(lines[lines.length - 1]);
    expect(status.event).toBe("Stop");
    expect(status.session_id).toBe("sess-parent");
  });

  test("unknown working_dir falls back to encoded dir creation", async () => {
    // A project dir exists but cwd is not a subdirectory of it
    const existingProjDir = join(tmpDir, "-home-user-existing");
    await mkdir(existingProjDir, { recursive: true });
    await writeFile(
      join(existingProjDir, "session.jsonl"),
      `${makeFirstLine("/home/user/existing", "sess-other")}\n`,
    );

    const unknownCwd = "/tmp/totally-unknown";
    const hookPayload = JSON.stringify({
      session_id: "sess-no-match",
      cwd: unknownCwd,
      hook_event_name: "Stop",
    });

    const result = await spawnCli(["status"], {
      stdin: hookPayload,
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).toBe(0);

    // Should fall back to encoded dir, not write to the existing project dir
    const encodedDir = join(tmpDir, unknownCwd.replace(/\//g, "-"));
    const raw = await readFile(join(encodedDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const status = JSON.parse(lines[lines.length - 1]);
    expect(status.session_id).toBe("sess-no-match");
  });
});

// ─── dump --watch ─────────────────────────────────────────────────────────────

describe("dump --watch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-watch");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("prints initial JSON state immediately on start", async () => {
    const projDir = join(tmpDir, "-home-user-watchproj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchproj", "sess-watch")}\n`,
    );

    // Disable OpenCode backend to avoid contamination from real sessions
    const cfgPath = join(tmpDir, "ccmon-config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({ backends: [{ type: "claude", enabled: true }] }),
    );

    // Start the watcher, wait briefly, then kill it
    const proc = spawn(NODE, [CLI_PATH, "dump", "--watch"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_PROJECTS_DIR: tmpDir,
        CCMON_CONFIG: cfgPath,
      },
    });

    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    // Give it time to print the initial state
    await new Promise((r) => setTimeout(r, 300));
    proc.kill("SIGINT");

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    await new Promise((r) => proc.once("close", r));

    // First output should be a valid JSON array
    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(blocks[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cwd).toBe("/home/user/watchproj");
  }, 5000);

  test("prints updated JSON when status file changes", async () => {
    const projDir = join(tmpDir, "-home-user-watchchange");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchchange", "sess-change")}\n`,
    );

    // Disable OpenCode backend to avoid contamination from real sessions
    const cfgPath = join(tmpDir, "ccmon-config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({ backends: [{ type: "claude", enabled: true }] }),
    );

    const proc = spawn(NODE, [CLI_PATH, "dump", "--watch"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_PROJECTS_DIR: tmpDir,
        CCMON_CONFIG: cfgPath,
      },
    });

    const stdoutChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    // Wait for initial state to print
    await new Promise((r) => setTimeout(r, 300));

    // Trigger a status file change (NDJSON format)
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n`,
    );
    // Wait for watcher debounce + propagation
    await new Promise((r) => setTimeout(r, 400));

    proc.kill("SIGINT");
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    await new Promise((r) => proc.once("close", r));

    // No separator lines — output is consecutive JSON blocks
    expect(stdout).not.toContain("---");

    // Each block should be independently parseable JSON
    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      expect(Array.isArray(parsed)).toBe(true);
    }
  }, 5000);

  test("exits cleanly on SIGINT", async () => {
    const proc = spawn(NODE, [CLI_PATH, "dump", "--watch"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    await new Promise((r) => setTimeout(r, 200));
    proc.kill("SIGINT");

    const exitCode: number | null = await new Promise((resolve) => {
      proc.once("close", (code: number | null) => resolve(code));
    });
    // Clean exit: 0 or signal-terminated (130 for SIGINT, or null)
    expect(exitCode === 0 || exitCode === 130 || exitCode === null).toBe(true);
  }, 5000);
});

// ─── sub ──────────────────────────────────────────────────────────────────────

describe("sub", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-sub");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("--port with no value → non-zero exit with stderr message (R17)", async () => {
    const result = await spawnCli(["sub", "--port"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--port requires a valid number");
  });

  test("--port -1 (out-of-range) → non-zero exit", async () => {
    const result = await spawnCli(["sub", "--port", "-1"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--port requires a valid number");
  });
});

// ─── dump --max-age strict parse ──────────────────────────────────────────────

describe("dump --max-age strict parse", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-cli-maxage-strict");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("--max-age 3.5abc (trailing garbage) → non-zero exit", async () => {
    const result = await spawnCli(["dump", "--max-age", "3.5abc"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--max-age requires a valid number");
  });

  test("--max-age 8080abc (trailing garbage) → non-zero exit", async () => {
    const result = await spawnCli(["dump", "--max-age", "8080abc"], {
      env: { CLAUDE_PROJECTS_DIR: tmpDir },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--max-age requires a valid number");
  });
});
