import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./_helpers";

const STATUS_LOG_FILE = "ccmon-status.jsonl";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const BUN = process.execPath;

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

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnCli(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn([BUN, "run", CLI_PATH, ...args], {
    stdin:
      options.stdin !== undefined
        ? new TextEncoder().encode(options.stdin)
        : "pipe",
    stdout: "pipe",
    stderr: "pipe",
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

  test("outputs single JSON object matching the given projectName", async () => {
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
    // Single object, not an array
    expect(Array.isArray(parsed)).toBe(false);
    expect(typeof parsed).toBe("object");
    expect(parsed.projectName).toBe("myapp");
    expect(parsed.cwd).toBe("/home/user/myapp");
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

  test("initial output is a single JSON object for the given project", async () => {
    const projDir = join(tmpDir, "-home-user-watchapp");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchapp", "sess-wp")}\n`,
    );

    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, "dump", "--watch", "--project", "watchapp"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
      },
    );

    await Bun.sleep(300);
    proc.kill("SIGINT");

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(blocks[0]);
    // Single object, not array
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.projectName).toBe("watchapp");
    expect(parsed.cwd).toBe("/home/user/watchapp");
  }, 5000);

  test("each update is a single JSON object after status file changes", async () => {
    const projDir = join(tmpDir, "-home-user-watchapp2");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/watchapp2", "sess-wp2")}\n`,
    );

    const proc = Bun.spawn(
      [BUN, "run", CLI_PATH, "dump", "--watch", "--project", "watchapp2"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
      },
    );

    await Bun.sleep(300);

    // Trigger a file change by touching the session JSONL (appending a line)
    const existingContent = await Bun.file(
      join(projDir, "session.jsonl"),
    ).text();
    await Bun.write(
      join(projDir, "session.jsonl"),
      `${existingContent}${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
    );
    await Bun.sleep(400);

    proc.kill("SIGINT");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const blocks = splitJsonBlocks(stdout);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = JSON.parse(block);
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed.projectName).toBe("watchapp2");
    }
  }, 5000);
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

    // Start the watcher, wait briefly, then kill it
    const proc = Bun.spawn([BUN, "run", CLI_PATH, "dump", "--watch"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Give it time to print the initial state
    await Bun.sleep(300);
    proc.kill("SIGINT");

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

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

    const proc = Bun.spawn([BUN, "run", CLI_PATH, "dump", "--watch"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    // Wait for initial state to print
    await Bun.sleep(300);

    // Trigger a status file change (NDJSON format)
    await appendFile(
      join(projDir, STATUS_LOG_FILE),
      `${makeStatusEvent("PostToolUse", "running")}\n`,
    );
    // Wait for watcher debounce + propagation
    await Bun.sleep(400);

    proc.kill("SIGINT");
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

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
    const proc = Bun.spawn([BUN, "run", CLI_PATH, "dump", "--watch"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECTS_DIR: tmpDir },
    });

    await Bun.sleep(200);
    proc.kill("SIGINT");

    const exitCode = await proc.exited;
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
});
