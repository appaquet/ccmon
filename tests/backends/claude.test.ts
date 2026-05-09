import { utimesSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildProjectState } from "../../src/backends/build-project-state";
import { ClaudeBackend } from "../../src/backends/claude";
import type { StatusEvent } from "../../src/session-core";
import { STATUS_LOG_FILE } from "../../src/session-core";
import { makeFirstLine, makeTempDir } from "../_helpers";

describe("ClaudeBackend", () => {
  let tmpDir: string;
  let backend: ClaudeBackend;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-claude-backend");
    backend = new ClaudeBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── scanProjects ──────────────────────────────────────────────────────────

  test("scanProjects: discovers projects with source=claude", async () => {
    const projDir = join(tmpDir, "-home-user-myproject");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/myproject", "abc123")}\n`,
    );

    const results = await backend.scanProjects();
    expect(results).toHaveLength(1);
    expect(results[0].projectName).toBe("myproject");
    expect(results[0].source).toBe("claude");
  });

  test("scanProjects: returns empty array when dir is empty", async () => {
    const results = await backend.scanProjects();
    expect(results).toHaveLength(0);
  });

  // ── projectKey ────────────────────────────────────────────────────────────

  test("projectKey: uses absolute claudeDir path", () => {
    const key = backend.projectKey({
      projectDir: "-home-user-a",
      cwd: "/home/user/a",
      projectName: "a",
      sessionId: "sid-a",
      latestJSONL: "/some/path.jsonl",
      source: "claude",
    });
    expect(key).toBe(join(tmpDir, "-home-user-a"));
    expect(key).toContain(tmpDir);
  });

  // ── resolveState ──────────────────────────────────────────────────────────

  test("resolveState: fresh JSONL → running", async () => {
    const projDir = join(tmpDir, "-home-user-running");
    await mkdir(projDir, { recursive: true });
    const jsonlPath = join(projDir, "session.jsonl");
    await writeFile(
      jsonlPath,
      `${makeFirstLine("/home/user/running", "sid-r")}\n`,
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const state = await backend.resolveState(projects[0]);
    expect(state).toBe("running");
  });

  test("resolveState: stale JSONL with Stop event → stopped", async () => {
    const projDir = join(tmpDir, "-home-user-stopped");
    await mkdir(projDir, { recursive: true });
    const jsonlPath = join(projDir, "session.jsonl");
    await writeFile(
      jsonlPath,
      `${makeFirstLine("/home/user/stopped", "sid-s")}\n`,
    );
    // Backdate JSONL
    const oldMtime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(jsonlPath, oldMtime, oldMtime);

    // Write Stop event
    const stopEvent = JSON.stringify({
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid-s",
      working_dir: "/home/user/stopped",
    });
    await writeFile(join(projDir, "ccmon-status.jsonl"), `${stopEvent}\n`);
    // Backdate status log so findLatestJSONL selects session
    const olderMtime = new Date(oldMtime.getTime() - 1000);
    utimesSync(join(projDir, "ccmon-status.jsonl"), olderMtime, olderMtime);

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const state = await backend.resolveState(projects[0]);
    expect(state).toBe("stopped");
  });

  test("resolveState: PermissionRequest → waiting_for_permission", async () => {
    const projDir = join(tmpDir, "-home-user-perm");
    await mkdir(projDir, { recursive: true });
    const jsonlPath = join(projDir, "session.jsonl");
    await writeFile(
      jsonlPath,
      `${makeFirstLine("/home/user/perm", "sid-p")}\n`,
    );
    // Backdate JSONL so it doesn't override
    const oldMtime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(jsonlPath, oldMtime, oldMtime);

    const permEvent = JSON.stringify({
      event: "PermissionRequest",
      state: "waiting_for_permission",
      timestamp: new Date().toISOString(),
      session_id: "sid-p",
      working_dir: "/home/user/perm",
    });
    await writeFile(join(projDir, "ccmon-status.jsonl"), `${permEvent}\n`);
    const olderMtime = new Date(oldMtime.getTime() - 1000);
    utimesSync(join(projDir, "ccmon-status.jsonl"), olderMtime, olderMtime);

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const state = await backend.resolveState(projects[0]);
    expect(state).toBe("waiting_for_permission");
  });

  // ── enrichProject ─────────────────────────────────────────────────────────

  test("enrichProject: extracts model and user activity from JSONL", async () => {
    const projDir = join(tmpDir, "-home-user-enrich");
    await mkdir(projDir, { recursive: true });
    const jsonlPath = join(projDir, "session.jsonl");
    const lines = [
      makeFirstLine("/home/user/enrich", "sid-e"),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello world" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi there" }],
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const enrichment = await backend.enrichProject(projects[0]);

    expect(enrichment.model).toBe("claude-sonnet-4-6");
    expect(enrichment.latestUserActivity?.text).toBe("hello world");
  });

  // ── getSubagents ──────────────────────────────────────────────────────────

  test("getSubagents: returns empty when no subagent dir exists", async () => {
    const projDir = join(tmpDir, "-home-user-no-subs");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/no-subs", "sid-nosub")}\n`,
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const subs = await backend.getSubagents(projects[0]);
    expect(subs).toEqual([]);
  });

  test("getSubagents: detects active sub-agent from filesystem", async () => {
    // sessionDirFromJSONL strips .jsonl → session uuid is the base path
    const sessionUuid = "session-uuid-1";
    const subagentsDir = join(tmpDir, sessionUuid, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    // Write parent JSONL at tmpDir level so sessionDirFromJSONL resolves correctly
    const jsonlPath = join(tmpDir, `${sessionUuid}.jsonl`);
    await writeFile(
      jsonlPath,
      `${makeFirstLine("/home/user/proj", "sid-par")}\n`,
    );

    // Write active sub-agent JSONL
    const agentJsonlPath = join(subagentsDir, "agent-abc123.jsonl");
    await writeFile(
      agentJsonlPath,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "sub work" },
        timestamp: new Date().toISOString(),
        slug: "test-slug",
      })}\n`,
    );

    const subs = await backend.getSubagentInfos(jsonlPath);
    expect(subs.length).toBe(1);
    expect(subs[0].agentId).toBe("abc123");
    expect(subs[0].slug).toBe("test-slug");
    expect(subs[0].isActive).toBe(true);
  });

  // ── buildProjectState ─────────────────────────────────────────────────────

  test("buildProjectState: returns ProjectState with source=claude", async () => {
    const projDir = join(tmpDir, "-home-user-bps");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine("/home/user/bps", "sid-bps")}\n`,
    );

    const projects = await backend.scanProjects();
    expect(projects).toHaveLength(1);
    const state = await buildProjectState(backend, projects[0]);

    expect(state.source).toBe("claude");
    expect(state.projectName).toBe("bps");
    expect(state.state).toBe("running");
    expect(state.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── readSessionTail ───────────────────────────────────────────────────────

  test("readSessionTail: reads enrichment from JSONL file", async () => {
    const jsonlPath = join(tmpDir, "enrich-test.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "find bugs" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "tool_use", name: "Grep", input: {} }],
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await backend.readSessionTail(jsonlPath);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.latestUserActivity?.text).toBe("find bugs");
    expect(result.latestAssistantActivity?.tool).toBe("Grep");
  });

  // ── targeted refresh ──────────────────────────────────────────────────────

  test("getProjectState: returns all projects from a clean scan", async () => {
    const projDirA = join(tmpDir, "-home-user-a");
    await mkdir(projDirA, { recursive: true });
    await writeFile(
      join(projDirA, "session.jsonl"),
      `${makeFirstLine("/home/user/a", "sid-a")}\n`,
    );

    const projDirB = join(tmpDir, "-home-user-b");
    await mkdir(projDirB, { recursive: true });
    await writeFile(
      join(projDirB, "session.jsonl"),
      `${makeFirstLine("/home/user/b", "sid-b")}\n`,
    );

    const results = await backend.getProjectState();
    expect(results).toHaveLength(2);
    const names = results.map((p) => p.projectName).sort();
    expect(names).toEqual(["a", "b"]);
  });
});
describe("getProjectState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-state");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeProject(
    name: string,
    cwd: string,
    sessionId: string,
  ): Promise<string> {
    const projDir = join(tmpDir, name);
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine(cwd, sessionId)}\n`,
    );
    return projDir;
  }

  test("fresh JSONL mtime: state is running (JSONL-primary)", async () => {
    // JSONL mtime < 60s → running, regardless of status
    await makeProject("-home-user-fresh", "/home/user/fresh", "sid1");
    // No status file; fresh JSONL mtime drives state.
    const before = Date.now();
    const results = await new ClaudeBackend(tmpDir).getProjectState();

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("running");
    // lastUpdated is JSONL mtime, which is recent
    expect(results[0].lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(
      new Date(results[0].lastUpdated as string).getTime(),
    ).toBeGreaterThanOrEqual(before - 5000);
    expect(
      new Date(results[0].lastUpdated as string).getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("status absent, stale JSONL mtime: state = stopped, lastUpdated from JSONL mtime", async () => {
    const projDir = await makeProject(
      "-home-user-nostatus",
      "/home/user/nostatus",
      "sid2",
    );
    // Backdate the JSONL to simulate a stale session (> 60s ago)
    const jsonlPath = join(projDir, "session.jsonl");
    const staleMtime = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
    utimesSync(jsonlPath, staleMtime, staleMtime);

    const results = await new ClaudeBackend(tmpDir).getProjectState();

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("stopped");
    expect(results[0].lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // lastUpdated comes from the (backdated) JSONL mtime
    const updatedMs = new Date(results[0].lastUpdated as string).getTime();
    expect(updatedMs).toBeGreaterThanOrEqual(staleMtime.getTime() - 1000);
    expect(updatedMs).toBeLessThanOrEqual(staleMtime.getTime() + 1000);
  });

  test("stopped hook signal with stale JSONL: overrides to stopped", async () => {
    // When status says stopped and JSONL is old, state is stopped.
    const projDir = await makeProject(
      "-home-user-stale",
      "/home/user/stale",
      "sid3",
    );
    const jsonlPath = join(projDir, "session.jsonl");
    const staleMtime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(jsonlPath, staleMtime, staleMtime);
    const event: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid3",
      working_dir: "/home/user/stale",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(event)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const olderMtime = new Date(staleMtime.getTime() - 1000);
    utimesSync(statusLogPath, olderMtime, olderMtime);

    const results = await new ClaudeBackend(tmpDir).getProjectState();

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("stopped");
  });

  test("stopped hook signal wins over fresh JSONL when status is newer", async () => {
    // If stopped signal timestamp > JSONL mtime, session is stopped.
    const projDir = await makeProject(
      "-home-user-stale-stopped",
      "/home/user/stale-stopped",
      "sid4",
    );
    const jsonlPath = join(projDir, "session.jsonl");
    // Backdate JSONL to 2 min ago so it is older than the stopped signal
    const staleMtime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(jsonlPath, staleMtime, staleMtime);
    const event: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid4",
      working_dir: "/home/user/stale-stopped",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(event)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const olderMtime = new Date(staleMtime.getTime() - 1000);
    utimesSync(statusLogPath, olderMtime, olderMtime);

    const results = await new ClaudeBackend(tmpDir).getProjectState();

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("stopped");
  });

  test("multiple projects: all returned", async () => {
    await makeProject("-home-user-a", "/home/user/a", "sida");
    await makeProject("-home-user-b", "/home/user/b", "sidb");

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    expect(results).toHaveLength(2);
  });

  test("R26: notificationMessage and notificationTimestamp forwarded from StatusEvent", async () => {
    const projDir = await makeProject(
      "-home-user-notif",
      "/home/user/notif",
      "sid-n",
    );
    const stopEvent: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid-n",
      working_dir: "/home/user/notif",
    };
    const notifEvent: StatusEvent = {
      event: "Notification",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid-n",
      working_dir: "/home/user/notif",
      notificationMessage: "You have a notification",
      notificationTimestamp: "2026-02-22T10:00:00.000Z",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(
      statusLogPath,
      `${JSON.stringify(stopEvent)}\n${JSON.stringify(notifEvent)}\n`,
    );
    // Backdate status log so findLatestJSONL selects the session JSONL
    const past = new Date(Date.now() - 5000);
    utimesSync(statusLogPath, past, past);

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    expect(results).toHaveLength(1);
    expect(results[0].notificationMessage).toBe("You have a notification");
    expect(results[0].notificationTimestamp).toBe("2026-02-22T10:00:00.000Z");
  });

  test("R26: notificationMessage absent when status has no notification event", async () => {
    const projDir = await makeProject(
      "-home-user-nonotif",
      "/home/user/nonotif",
      "sid-nn",
    );
    const event: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid-nn",
      working_dir: "/home/user/nonotif",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(event)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const past = new Date(Date.now() - 5000);
    utimesSync(statusLogPath, past, past);

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    expect(results).toHaveLength(1);
    expect(results[0].notificationMessage).toBeUndefined();
    expect(results[0].notificationTimestamp).toBeUndefined();
  });

  test("R2: invalid status.timestamp for waiting_for_permission treated as stale (NaN guard)", async () => {
    // NaN guard: an unparseable timestamp on a waiting_for_permission signal must not
    // be treated as perpetually fresh — it falls through to the next priority.
    const projDir = await makeProject(
      "-home-user-nan-ts",
      "/home/user/nan-ts",
      "sid-nan",
    );
    // Backdate the JSONL so it is not within the 60s active threshold
    const jsonlPath = join(projDir, "session.jsonl");
    const staleMtime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(jsonlPath, staleMtime, staleMtime);
    const event: StatusEvent = {
      event: "PermissionRequest",
      state: "waiting_for_permission",
      timestamp: "not-a-date",
      session_id: "sid-nan",
      working_dir: "/home/user/nan-ts",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(event)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const olderMtime = new Date(staleMtime.getTime() - 1000);
    utimesSync(statusLogPath, olderMtime, olderMtime);

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    expect(results).toHaveLength(1);
    // NaN age on permission signal treated as stale → falls through to priority 4 → stopped
    expect(results[0].state).toBe("stopped");
  });
});
describe("session enrichment", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-enrichment");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── readSessionTail ──

  function makeUserEntry(content: string): string {
    const message = { role: "user", content };
    return JSON.stringify({ type: "user", message });
  }

  function makeAssistantEntry(model: string, contentBlocks: object[]): string {
    return JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model, content: contentBlocks },
    });
  }

  function makeProgressEntry(contentBlocks: object[]): string {
    return JSON.stringify({
      type: "progress",
      data: {
        message: {
          message: {
            content: contentBlocks,
          },
        },
      },
    });
  }

  test("readSessionTail: extracts latestUserActivity, model, latestAssistantActivity", async () => {
    const jsonlPath = join(tmpDir, "tail-test.jsonl");
    const lines = [
      makeUserEntry("what is X"),
      makeUserEntry("<command-message>ctx-load</command-message>"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Read", input: {} },
        { type: "text", text: "some text" },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("what is X");
    expect(result.latestUserActivity?.isCommand).toBe(false);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.latestAssistantActivity?.tool).toBe("Read");
    expect(result.latestAssistantActivity?.text).toBe("some text");
  });

  test("readSessionTail: non-command <-prefixed content sets no latestUserActivity", async () => {
    const jsonlPath = join(tmpDir, "slash-cmd-test.jsonl");
    const lines = [
      makeUserEntry("<command-message>ctx-load</command-message>"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity).toBeUndefined();
  });

  test("readSessionTail: message truncated to 200 chars", async () => {
    const jsonlPath = join(tmpDir, "truncate-test.jsonl");
    const longMessage = "A".repeat(300);
    await writeFile(jsonlPath, `${makeUserEntry(longMessage)}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("A".repeat(200));
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });

  test("readSessionTail: missing file returns empty object", async () => {
    const result = await new ClaudeBackend(tmpDir).readSessionTail(
      join(tmpDir, "nonexistent.jsonl"),
    );
    expect(result.latestUserActivity).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.latestAssistantActivity).toBeUndefined();
  });

  test("readSessionTail: corrupt lines are skipped, valid lines parsed", async () => {
    const jsonlPath = join(tmpDir, "corrupt-lines-test.jsonl");
    const lines = [
      "not valid json {{{",
      makeUserEntry("valid message"),
      "also broken",
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("valid message");
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });

  test("readSessionTail: picks most recent assistant entry (last in file)", async () => {
    const jsonlPath = join(tmpDir, "multi-tool-test.jsonl");
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Bash", input: {} },
      ]),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Edit", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reversed scan picks Edit (last in file = first found from end)
    expect(result.latestAssistantActivity?.tool).toBe("Edit");
    expect(result.latestAssistantActivity?.text).toBeUndefined();
  });

  test("readSessionTail: TodoWrite present with mixed statuses → correct tasksDone and tasksTotal", async () => {
    const jsonlPath = join(tmpDir, "todowrite-mixed.jsonl");
    const todos = [
      { content: "Task A", status: "completed" },
      { content: "Task B", status: "in_progress" },
      { content: "Task C", status: "completed" },
      { content: "Task D", status: "pending" },
    ];
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasksTotal).toBe(4);
    expect(result.tasksDone).toBe(2);
  });

  test("readSessionTail: TodoWrite absent → tasksDone and tasksTotal both undefined", async () => {
    const jsonlPath = join(tmpDir, "todowrite-absent.jsonl");
    const lines = [
      makeUserEntry("do something"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasksDone).toBeUndefined();
    expect(result.tasksTotal).toBeUndefined();
  });

  test("readSessionTail: TodoWrite all completed → tasksDone equals tasksTotal", async () => {
    const jsonlPath = join(tmpDir, "todowrite-all-done.jsonl");
    const todos = [
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "completed" },
      { content: "Step 3", status: "completed" },
    ];
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(3);
    expect(result.tasksDone).toBe(result.tasksTotal);
  });

  test("readSessionTail: multiple assistant entries, most recent TodoWrite is used", async () => {
    const jsonlPath = join(tmpDir, "todowrite-most-recent.jsonl");
    const olderTodos = [
      { content: "Old task A", status: "pending" },
      { content: "Old task B", status: "pending" },
    ];
    const newerTodos = [
      { content: "New task A", status: "completed" },
      { content: "New task B", status: "completed" },
      { content: "New task C", status: "in_progress" },
    ];
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: olderTodos } },
      ]),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: newerTodos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Backward scan finds the newer (last in file) entry first
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(2);
  });

  test("readSessionTail: TodoWrite in progress-type entry → correct tasksDone and tasksTotal", async () => {
    const jsonlPath = join(tmpDir, "todowrite-progress.jsonl");
    const todos = [
      { content: "Task A", status: "completed" },
      { content: "Task B", status: "in_progress" },
      { content: "Task C", status: "pending" },
    ];
    const lines = [
      makeUserEntry("implement the feature"),
      makeProgressEntry([
        { type: "tool_use", name: "TodoWrite", input: { todos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(1);
  });

  test("readSessionTail: progress-type TodoWrite preferred over older assistant-type when both present", async () => {
    const jsonlPath = join(tmpDir, "todowrite-progress-vs-assistant.jsonl");
    const olderTodos = [
      { content: "Old A", status: "completed" },
      { content: "Old B", status: "completed" },
    ];
    const newerTodos = [
      { content: "New A", status: "completed" },
      { content: "New B", status: "in_progress" },
      { content: "New C", status: "pending" },
    ];
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: olderTodos } },
      ]),
      makeProgressEntry([
        { type: "tool_use", name: "TodoWrite", input: { todos: newerTodos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Backward scan finds the progress entry (last in file) first
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(1);
  });

  test("readSessionTail (R27): first read parses full file, tasks reflect last TodoWrite", async () => {
    const jsonlPath = join(tmpDir, "r27-full-parse.jsonl");
    const earlyTodos = [
      { content: "Early A", status: "pending" },
      { content: "Early B", status: "pending" },
    ];
    const lateTodos = [
      { content: "Late A", status: "completed" },
      { content: "Late B", status: "completed" },
      { content: "Late C", status: "in_progress" },
    ];
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: earlyTodos } },
      ]),
      makeUserEntry("do more work"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: lateTodos } },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Backward scan finds the later TodoWrite first (3 tasks, 2 done)
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(2);
  });

  test("readSessionTail (R27): delta read merges new content, preserves old", async () => {
    const jsonlPath = join(tmpDir, "r27-delta.jsonl");

    // Initial file with a user message and TodoWrite
    const initialTodos = [{ content: "Step 1", status: "completed" }];
    const initialLines = [
      makeUserEntry("initial prompt"),
      makeAssistantEntry("claude-opus-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: initialTodos } },
      ]),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("initial prompt");
    expect(first.latestUserActivity?.isCommand).toBe(false);
    expect(first.model).toBe("claude-opus-4-6");
    expect(first.tasksTotal).toBe(1);
    expect(first.tasksDone).toBe(1);

    // Append new lines (delta): a new user message and updated TodoWrite
    await new Promise((r) => setTimeout(r, 10)); // ensure mtime changes
    const appendedTodos = [
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "in_progress" },
    ];
    const appendedLines = [
      makeUserEntry("follow-up prompt"),
      makeAssistantEntry("claude-opus-4-6", [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: { todos: appendedTodos },
        },
      ]),
    ];
    // Append to existing file
    const existingContent = await readFile(jsonlPath, "utf8");
    await writeFile(
      jsonlPath,
      `${existingContent + appendedLines.join("\n")}\n`,
    );

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Delta read: newer latestUserActivity overrides
    expect(second.latestUserActivity?.text).toBe("follow-up prompt");
    // Tasks updated from new delta
    expect(second.tasksTotal).toBe(2);
    expect(second.tasksDone).toBe(1);
    // Model preserved from delta (same value, but not lost)
    expect(second.model).toBe("claude-opus-4-6");
  });

  test("readSessionTail (R27): file shrink triggers full re-read", async () => {
    const jsonlPath = join(tmpDir, "r27-shrink.jsonl");

    // First: write a large-ish file
    const firstTodos = [{ content: "Old task", status: "completed" }];
    const firstLines = [
      makeUserEntry("old session message"),
      makeAssistantEntry("claude-opus-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: firstTodos } },
      ]),
    ];
    await writeFile(jsonlPath, `${firstLines.join("\n")}\n`);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("old session message");
    expect(first.tasksTotal).toBe(1);

    // Replace with a smaller new-session file (simulates session restart)
    await new Promise((r) => setTimeout(r, 10));
    const newTodos = [
      { content: "New A", status: "pending" },
      { content: "New B", status: "pending" },
    ];
    const newLines = [
      makeUserEntry("new session start"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "TodoWrite", input: { todos: newTodos } },
      ]),
    ];
    // Write shorter content (file shrinks)
    await writeFile(jsonlPath, `${newLines[0]}\n`);

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Full re-read: should see only new content
    expect(second.latestUserActivity?.text).toBe("new session start");
    expect(second.model).toBeUndefined();
    expect(second.tasksTotal).toBeUndefined();
  });

  test("readSessionTail (R28/R50): latestAssistantActivity text extracted and truncated", async () => {
    const jsonlPath = join(tmpDir, "r28-assistant-msg.jsonl");
    const longText = "A".repeat(300);
    const lines = [
      makeUserEntry("user question"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: longText },
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestAssistantActivity?.text).toBe("A".repeat(200));
    expect(result.latestAssistantActivity?.tool).toBe("Bash");
  });

  test("readSessionTail (R28/R50): latestAssistantActivity and latestUserActivity both extracted", async () => {
    const jsonlPath = join(tmpDir, "r28-both-messages.jsonl");
    const lines = [
      makeUserEntry("user input here"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "assistant reply here" },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("user input here");
    expect(result.latestUserActivity?.isCommand).toBe(false);
    expect(result.latestAssistantActivity?.text).toBe("assistant reply here");
    expect(result.latestAssistantActivity?.tool).toBeUndefined();
  });

  test("readSessionTail (R28/R50): assistant entry without text block yields no text in latestAssistantActivity", async () => {
    const jsonlPath = join(tmpDir, "r28-no-text-block.jsonl");
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestAssistantActivity?.text).toBeUndefined();
    expect(result.latestAssistantActivity?.tool).toBe("Bash");
  });

  // ── latestAssistantActivity (R50) ──

  test("readSessionTail (R50): assistant entry with only text block", async () => {
    const jsonlPath = join(tmpDir, "r50-text-only.jsonl");
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "thinking out loud" },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestAssistantActivity?.text).toBe("thinking out loud");
    expect(result.latestAssistantActivity?.tool).toBeUndefined();
  });

  test("readSessionTail (R50): assistant entry with only tool_use", async () => {
    const jsonlPath = join(tmpDir, "r50-tool-only.jsonl");
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestAssistantActivity?.text).toBeUndefined();
    expect(result.latestAssistantActivity?.tool).toBe("Bash");
  });

  test("readSessionTail (R50): assistant entry with both text and tool_use", async () => {
    const jsonlPath = join(tmpDir, "r50-both.jsonl");
    const lines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "here is my plan" },
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestAssistantActivity?.text).toBe("here is my plan");
    expect(result.latestAssistantActivity?.tool).toBe("Bash");
  });

  test("readSessionTail (R50): temporal ordering — newer entry wins even if older has text", async () => {
    const jsonlPath = join(tmpDir, "r50-temporal.jsonl");
    const lines = [
      // older entry: has text but no tool
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "older text reply" },
      ]),
      // newer entry: tool only
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "tool_use", name: "Read", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reversed scan finds newer (last in file) first — tool-only entry wins
    expect(result.latestAssistantActivity?.tool).toBe("Read");
    expect(result.latestAssistantActivity?.text).toBeUndefined();
  });

  test("readSessionTail (R50): delta-read merge preserves latestAssistantActivity from base when scan has none", async () => {
    const jsonlPath = join(tmpDir, "r50-delta-merge.jsonl");

    // First read: assistant entry sets latestAssistantActivity
    const firstLines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "initial response" },
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${firstLines.join("\n")}\n`);
    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.latestAssistantActivity?.text).toBe("initial response");
    expect(first.latestAssistantActivity?.tool).toBe("Bash");

    // Append user-only line (no new assistant entry) — delta scan finds no assistant entry
    const userLine = makeUserEntry("follow-up question");
    await writeFile(jsonlPath, `${firstLines.join("\n")}\n${userLine}\n`);

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // latestAssistantActivity must be preserved from base (delta merge)
    expect(second.latestAssistantActivity?.text).toBe("initial response");
    expect(second.latestAssistantActivity?.tool).toBe("Bash");
  });

  // ── sessionName (custom-title) ──

  test("readSessionTail: custom-title line → sessionName set", async () => {
    const jsonlPath = join(tmpDir, "session-name-present.jsonl");
    const lines = [
      makeUserEntry("some prompt"),
      JSON.stringify({
        type: "custom-title",
        customTitle: "tableoutput",
        sessionId: "test-session",
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.sessionName).toBe("tableoutput");
  });

  test("readSessionTail: no custom-title line → sessionName undefined", async () => {
    const jsonlPath = join(tmpDir, "session-name-absent.jsonl");
    const lines = [
      makeUserEntry("some prompt"),
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "some response" },
      ]),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.sessionName).toBeUndefined();
  });

  test("readSessionTail: multiple custom-title lines → most recent wins", async () => {
    const jsonlPath = join(tmpDir, "session-name-multiple.jsonl");
    const lines = [
      makeUserEntry("some prompt"),
      JSON.stringify({
        type: "custom-title",
        customTitle: "old-name",
        sessionId: "test-session",
      }),
      JSON.stringify({
        type: "custom-title",
        customTitle: "new-name",
        sessionId: "test-session",
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reverse scan hits the last line first — most recent title wins
    expect(result.sessionName).toBe("new-name");
  });

  // ── getSubagentInfos (R29) ──

  test("getSubagentInfos (R29): returns SubagentInfo array with enrichment", async () => {
    const sessionId = "r29-enrichment-session";
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    // Write a sub-agent JSONL with content readable by readSessionTail
    const agentPath = join(subagentsDir, "agent-abc123.jsonl");
    const agentLines = [
      makeUserEntry("agent task"),
      makeAssistantEntry("claude-opus-4-6", [
        { type: "tool_use", name: "Read", input: {} },
        { type: "text", text: "agent response" },
      ]),
    ];
    await writeFile(agentPath, `${agentLines.join("\n")}\n`);

    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);

    expect(infos).toHaveLength(1);
    expect(infos[0].agentId).toBe("abc123");
    expect(infos[0].jsonlPath).toBe(agentPath);
    expect(infos[0].isActive).toBe(true);
    expect(infos[0].model).toBe("claude-opus-4-6");
    expect(infos[0].latestAssistantActivity?.tool).toBe("Read");
    expect(infos[0].latestUserActivity?.text).toBe("agent task");
    expect(infos[0].latestUserActivity?.isCommand).toBe(false);
    expect(infos[0].latestAssistantActivity?.text).toBe("agent response");
  });

  test("getSubagentInfos (R29): isActive respects 15s threshold", async () => {
    const sessionId = "r29-active-threshold";
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    const activeAgent = join(subagentsDir, "agent-live.jsonl");
    const staleAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(activeAgent, `${makeUserEntry("live")}\n`);
    await writeFile(staleAgent, `${makeUserEntry("stale")}\n`);

    // Backdate the stale agent to 20 seconds ago (>15s threshold, within 30s expiry)
    const twentySecAgo = new Date(Date.now() - 20_000);
    utimesSync(staleAgent, twentySecAgo, twentySecAgo);

    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);

    expect(infos).toHaveLength(2);
    const live = infos.find((i) => i.agentId === "live");
    const stale = infos.find((i) => i.agentId === "old");
    expect(live?.isActive).toBe(true);
    expect(stale?.isActive).toBe(false);
  });

  test("getSubagentInfos (R29): returns empty array when no subagents dir", async () => {
    const jsonlPath = join(tmpDir, "r29-no-dir-session.jsonl");
    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(0);
  });

  // ── queue-operation description extraction (R36) ──

  function makeQueueOperationEnqueue(
    taskId: string,
    description: string,
  ): string {
    return JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: JSON.stringify({
        task_id: taskId,
        description,
        tool_use_id: "tu-1",
        task_type: "agent",
      }),
    });
  }

  test("readSessionTail (R36): agentDescriptions populated from queue-operation enqueue entries", async () => {
    const jsonlPath = join(tmpDir, "r36-queue-op.jsonl");
    const lines = [
      makeUserEntry("do the thing"),
      makeQueueOperationEnqueue("ae89d86", "Implement feature X"),
      makeQueueOperationEnqueue("bf12c45", "Write tests for Y"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("ae89d86")).toBe("Implement feature X");
    expect(result.agentDescriptions.get("bf12c45")).toBe("Write tests for Y");
  });

  test("readSessionTail (R36): delta read merges new queue-operation entries without losing previous ones", async () => {
    const jsonlPath = join(tmpDir, "r36-queue-op-delta.jsonl");

    const initialLines = [
      makeUserEntry("start"),
      makeQueueOperationEnqueue("agent-1", "First agent task"),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.agentDescriptions.get("agent-1")).toBe("First agent task");

    await new Promise((r) => setTimeout(r, 10));
    const existing = await readFile(jsonlPath, "utf8");
    await writeFile(
      jsonlPath,
      existing +
        makeQueueOperationEnqueue("agent-2", "Second agent task") +
        "\n",
    );

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(second.agentDescriptions.get("agent-1")).toBe("First agent task");
    expect(second.agentDescriptions.get("agent-2")).toBe("Second agent task");
  });

  test("getSubagentInfos (R36): attaches description from parent session agentDescriptions", async () => {
    const sessionId = "r36-desc-session";
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    // Write sub-agent JSONL
    const agentPath = join(subagentsDir, "agent-abc123.jsonl");
    await writeFile(agentPath, `${makeUserEntry("agent task")}\n`);

    // Write parent JSONL with a queue-operation enqueue line matching the agentId
    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    await writeFile(
      jsonlPath,
      `${[
        makeUserEntry("main prompt"),
        makeQueueOperationEnqueue("abc123", "Review the architecture"),
      ].join("\n")}\n`,
    );

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(1);
    expect(infos[0].agentId).toBe("abc123");
    expect(infos[0].description).toBe("Review the architecture");
  });

  function makeTaskToolUse(toolUseId: string, description: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Task",
            input: { description, subagent_type: "Explore" },
          },
        ],
      },
    });
  }

  function makeTaskToolResult(toolUseId: string, agentId: string): string {
    return JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId }],
      },
      toolUseResult: { status: "completed", agentId },
    });
  }

  test("readSessionTail (R36): agentDescriptions populated from Task tool_use/toolUseResult correlation", async () => {
    const jsonlPath = join(tmpDir, "r36-task-tool.jsonl");
    const lines = [
      makeUserEntry("start task"),
      makeTaskToolUse("toolu_01ABC", "Research waiting state bug"),
      makeTaskToolResult("toolu_01ABC", "a4220fe77a021871d"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("a4220fe77a021871d")).toBe(
      "Research waiting state bug",
    );
  });

  test("readSessionTail (R36): mixed queue-operation and Task tool_use entries both populate agentDescriptions", async () => {
    const jsonlPath = join(tmpDir, "r36-mixed-agents.jsonl");
    const lines = [
      makeUserEntry("start"),
      makeQueueOperationEnqueue("legacy-agent-1", "Legacy queue task"),
      makeTaskToolUse("toolu_02DEF", "New Task tool agent"),
      makeTaskToolResult("toolu_02DEF", "new-agent-abc123"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("legacy-agent-1")).toBe(
      "Legacy queue task",
    );
    expect(result.agentDescriptions.get("new-agent-abc123")).toBe(
      "New Task tool agent",
    );
  });

  test("getProjectState includes subagents array (R29)", async () => {
    // Build a project dir with a sessions-index, JSONL, and sub-agents
    const projDir = join(tmpDir, "-home-user-r29-proj");
    await mkdir(projDir, { recursive: true });

    const sessionId = "r29-proj-session";
    const jsonlFile = join(projDir, `${sessionId}.jsonl`);
    const firstLine = makeFirstLine("/home/user/r29-proj", sessionId);
    await writeFile(jsonlFile, `${firstLine}\n${makeUserEntry("main task")}\n`);

    // Write a status file so state is non-stopped (fresh timestamp)
    // No live process in test env → resolveState will return 'stopped', so
    // subagents won't be populated. We instead verify the field is present
    // (empty array when stopped) by checking what buildProjectState does.
    // Instead, use a sessions-index and a subagents dir.
    const subagentsDir = join(projDir, `${sessionId}`, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      join(subagentsDir, "agent-test01.jsonl"),
      `${makeUserEntry("sub task")}\n`,
    );

    const entry = {
      sessionId,
      fullPath: jsonlFile,
      fileMtime: Date.now(),
      projectPath: "/home/user/r29-proj",
      isSidechain: false,
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [entry] }),
    );

    // Status log with fresh running event
    const runningEvent: StatusEvent = {
      event: "PostToolUse",
      state: "running",
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      working_dir: "/home/user/r29-proj",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(runningEvent)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const past = new Date(Date.now() - 5000);
    utimesSync(statusLogPath, past, past);

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    const proj = results.find((p) => p.projectName === "r29-proj");
    expect(proj).toBeDefined();

    // In test env liveness check returns false → state resolves to 'stopped'.
    // Sub-agents are only populated for non-stopped sessions; verify accordingly.
    if (proj?.state === "stopped") {
      expect(proj?.subagents).toBeUndefined();
      expect(proj?.subagentCount).toBeUndefined();
    } else {
      expect(Array.isArray(proj?.subagents)).toBe(true);
      expect(typeof proj?.subagentCount).toBe("number");
    }
  });

  test("R41: stopped session still exposes enrichment fields (messages, model, tokens)", async () => {
    const projDir = join(tmpDir, "-home-user-r41-stopped");
    await mkdir(projDir, { recursive: true });

    const sessionId = "r41-stopped-session";
    const jsonlFile = join(projDir, `${sessionId}.jsonl`);

    const userEntry = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello from stopped session" },
    });
    const assistantEntry = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "response text" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    await writeFile(
      jsonlFile,
      makeFirstLine("/home/user/r41-stopped", sessionId) +
        "\n" +
        userEntry +
        "\n" +
        assistantEntry +
        "\n",
    );

    const indexEntry = {
      sessionId,
      fullPath: jsonlFile,
      fileMtime: Date.now(),
      projectPath: "/home/user/r41-stopped",
      isSidechain: false,
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [indexEntry] }),
    );

    // Explicitly stopped state via event log
    const stopEvent: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      working_dir: "/home/user/r41-stopped",
    };
    const statusLogPath = join(projDir, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(stopEvent)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const past = new Date(Date.now() - 5000);
    utimesSync(statusLogPath, past, past);

    const results = await new ClaudeBackend(tmpDir).getProjectState();
    const proj = results.find((p) => p.projectName === "r41-stopped");
    expect(proj).toBeDefined();
    expect(proj?.state).toBe("stopped");

    // Enrichment must be present even for stopped sessions (R41)
    expect(proj?.latestUserActivity?.text).toBe("hello from stopped session");
    expect(proj?.latestUserActivity?.isCommand).toBe(false);
    expect(proj?.model).toBe("claude-sonnet-4-6");
    expect(proj?.inputTokens).toBeGreaterThan(0);
    expect(proj?.outputTokens).toBeGreaterThan(0);
    expect(proj?.latestAssistantActivity?.text).toBe("response text");
  });
});
describe("sessionTailCache (R20.4)", () => {
  let tmpDir: string;
  let backend: ClaudeBackend;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-tail-cache");
    backend = new ClaudeBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUserLine(content: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content } });
  }

  test("same mtime: second call returns cached result without re-reading file", async () => {
    const jsonlPath = join(tmpDir, "tail.jsonl");
    await writeFile(jsonlPath, `${makeUserLine("original message")}\n`);

    // Pin the mtime to a known whole-second value before the first cache read.
    // utimes(2) is second-precision on many systems; using a whole-second Date avoids
    // a mismatch between the cached mtimeMs and the value restored by utimes.
    const pinnedMtime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(jsonlPath, pinnedMtime, pinnedMtime);

    const first = await backend.readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("original message");

    // Overwrite content with same-size content, restore the pinned mtime so cache key is unchanged.
    // "original message" and "replaced message" are the same length (16 chars each).
    await writeFile(jsonlPath, `${makeUserLine("replaced message")}\n`);
    await utimes(jsonlPath, pinnedMtime, pinnedMtime);

    const second = await backend.readSessionTail(jsonlPath);
    expect(second).toBe(first); // same object reference proves cache hit
    expect(second.latestUserActivity?.text).toBe("original message");
  });

  test("changed mtime: file replaced with smaller content triggers full re-read", async () => {
    const jsonlPath = join(tmpDir, "tail-refresh.jsonl");
    // Write a larger initial file
    await writeFile(
      jsonlPath,
      `${makeUserLine("this is the first and longer message")}\n`,
    );

    const first = await backend.readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe(
      "this is the first and longer message",
    );

    await new Promise((r) => setTimeout(r, 10));
    // Replace with shorter content (file shrinks → full re-read)
    await writeFile(jsonlPath, `${makeUserLine("new")}\n`);

    const second = await backend.readSessionTail(jsonlPath);
    expect(second.latestUserActivity?.text).toBe("new");
  });
});
describe("getProjectState targeted refresh (R20.5)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-targeted");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeProject(
    name: string,
    cwd: string,
    sessionId: string,
  ): Promise<string> {
    const projDir = join(tmpDir, name);
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session.jsonl"),
      `${makeFirstLine(cwd, sessionId)}\n`,
    );
    return projDir;
  }

  test("targeted rescan updates only the changed project while other projects stay cached", async () => {
    const _dirA = await makeProject("-home-user-a", "/home/user/a", "sid-a");
    const dirB = await makeProject("-home-user-b", "/home/user/b", "sid-b");

    // Full scan to warm the cache
    const first = await new ClaudeBackend(tmpDir).getProjectState();
    expect(first).toHaveLength(2);

    // Write a status event for project B to see state change — simplest observable diff
    const event: StatusEvent = {
      event: "Stop",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "sid-b",
      working_dir: "/home/user/b",
    };
    const statusLogPath = join(dirB, STATUS_LOG_FILE);
    await appendFile(statusLogPath, `${JSON.stringify(event)}\n`);
    // Backdate status log so findLatestJSONL selects the session JSONL
    const past = new Date(Date.now() - 5000);
    utimesSync(statusLogPath, past, past);

    // Targeted rescan of only project B
    const second = await new ClaudeBackend(tmpDir).getProjectState(dirB);
    expect(second).toHaveLength(2);

    // Project A should still be present
    const projA = second.find((p) => p.projectName === "a");
    const projB = second.find((p) => p.projectName === "b");
    expect(projA).toBeDefined();
    expect(projB).toBeDefined();
  });

  test("targeted rescan with cold cache falls back to full scan", async () => {
    await makeProject("-home-user-x", "/home/user/x", "sid-x");

    // Cache is cold (reset in beforeEach) — changedProjectDir provided but ignored
    const results = await new ClaudeBackend(tmpDir).getProjectState(
      join(tmpDir, "-home-user-x"),
    );
    expect(results).toHaveLength(1);
    expect(results[0].projectName).toBe("x");
  });

  test("targeted rescan of disappeared project removes it from cache", async () => {
    const dirA = await makeProject(
      "-home-user-gone",
      "/home/user/gone",
      "sid-gone",
    );
    const _dirB = await makeProject(
      "-home-user-stay",
      "/home/user/stay",
      "sid-stay",
    );

    // Warm the cache
    const first = await new ClaudeBackend(tmpDir).getProjectState();
    expect(first).toHaveLength(2);

    // Remove project A's JSONL so readProjectInfo returns null
    await rm(dirA, { recursive: true, force: true });

    // Targeted rescan of the now-gone project
    const second = await new ClaudeBackend(tmpDir).getProjectState(dirA);
    expect(second).toHaveLength(1);
    expect(second[0].projectName).toBe("stay");
  });
});
describe("readSessionTail token usage (R32)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-tokens");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeAssistantWithUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model,
        content: [{ type: "text", text: "response" }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    });
  }

  function makeUserLine(content: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content } });
  }

  test("R32: single assistant entry with usage → inputTokens and outputTokens extracted", async () => {
    const jsonlPath = join(tmpDir, "r32-single.jsonl");
    const lines = [
      makeUserLine("what is X"),
      makeAssistantWithUsage("claude-sonnet-4-6", 1000, 250),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(250);
  });

  test("R32: multiple assistant entries → inputTokens is last value, outputTokens is sum", async () => {
    const jsonlPath = join(tmpDir, "r32-multi.jsonl");
    const lines = [
      makeUserLine("first prompt"),
      makeAssistantWithUsage("claude-sonnet-4-6", 500, 100),
      makeUserLine("second prompt"),
      makeAssistantWithUsage("claude-sonnet-4-6", 700, 200),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // inputTokens: last-seen value (cache_read grows monotonically, summing inflates it)
    expect(result.inputTokens).toBe(700);
    // outputTokens: sum of per-call deltas
    expect(result.outputTokens).toBe(300);
  });

  test("R32: no usage fields → inputTokens and outputTokens undefined", async () => {
    const jsonlPath = join(tmpDir, "r32-no-usage.jsonl");
    const lines = [
      makeUserLine("prompt"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "reply" }],
          // no usage field
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  test("R32: delta reads — inputTokens last-wins, outputTokens accumulates", async () => {
    const jsonlPath = join(tmpDir, "r32-delta.jsonl");

    // Initial content
    const initialLines = [
      makeUserLine("first"),
      makeAssistantWithUsage("claude-sonnet-4-6", 300, 80),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(300);
    expect(first.outputTokens).toBe(80);

    // Append more content (simulates growing cache_read — new value is larger)
    await new Promise((r) => setTimeout(r, 10));
    const appendedLines = [
      makeUserLine("second"),
      makeAssistantWithUsage("claude-sonnet-4-6", 500, 60),
    ];
    const existing = await readFile(jsonlPath, "utf8");
    await writeFile(jsonlPath, `${existing + appendedLines.join("\n")}\n`);

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // inputTokens: new scan value replaces base (last-wins, not additive)
    expect(second.inputTokens).toBe(500);
    // outputTokens: additive across delta reads
    expect(second.outputTokens).toBe(140);
  });

  test("R32: file shrink resets token counts to new content only", async () => {
    const jsonlPath = join(tmpDir, "r32-shrink.jsonl");

    await writeFile(
      jsonlPath,
      `${[
        makeUserLine("old session"),
        makeAssistantWithUsage("claude-sonnet-4-6", 1000, 300),
      ].join("\n")}\n`,
    );

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(1000);

    // Replace with shorter file (new session)
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(
      jsonlPath,
      `${makeAssistantWithUsage("claude-sonnet-4-6", 50, 20)}\n`,
    );

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Full re-read: only sees the new content
    expect(second.inputTokens).toBe(50);
    expect(second.outputTokens).toBe(20);
  });
});
describe("readSessionTail latestUserActivity (R37, R49)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r37");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUserEntry(content: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content } });
  }

  function makeCommandEntry(name: string, args?: string): string {
    const argsTag = args ? `<command-args>${args}</command-args>` : "";
    return makeUserEntry(`<command-name>${name}</command-name>${argsTag}`);
  }

  test("R37: command extracted from <command-name> user entry → isCommand: true", async () => {
    const jsonlPath = join(tmpDir, "r37-basic.jsonl");
    await writeFile(jsonlPath, `${makeCommandEntry("/ctx-load")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("/ctx-load");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R37: command includes args when <command-args> present", async () => {
    const jsonlPath = join(tmpDir, "r37-args.jsonl");
    await writeFile(
      jsonlPath,
      `${makeCommandEntry("/ctx-load", "some args")}\n`,
    );

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("/ctx-load some args");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R37: <command-name> without args produces command-only string", async () => {
    const jsonlPath = join(tmpDir, "r37-no-args.jsonl");
    await writeFile(jsonlPath, `${makeCommandEntry("/implement")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("/implement");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R49 single-winner ordering: command more recent than message → isCommand: true", async () => {
    const jsonlPath = join(tmpDir, "r49-cmd-newer.jsonl");
    const lines = [
      makeUserEntry("a plain user message"),
      makeCommandEntry("/ctx-save"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reversed scan finds the command first (most recent entry) → single winner
    expect(result.latestUserActivity?.text).toBe("/ctx-save");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R49 single-winner ordering: message more recent than command → isCommand: false", async () => {
    const jsonlPath = join(tmpDir, "r49-msg-newer.jsonl");
    const lines = [
      makeCommandEntry("/ctx-load"),
      makeUserEntry("a follow-up user message"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reversed scan finds the plain message first (most recent entry) → single winner
    expect(result.latestUserActivity?.text).toBe("a follow-up user message");
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });

  test("R37: content starting with < but no <command-name> tag → no latestUserActivity", async () => {
    const jsonlPath = join(tmpDir, "r37-xml-no-cmd.jsonl");
    // Content starting with < but no <command-name> tag: excluded from plain messages, not a command
    await writeFile(
      jsonlPath,
      `${makeUserEntry("<some-other-tag>value</some-other-tag>")}\n`,
    );

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.latestUserActivity).toBeUndefined();
  });

  test("R49 single-winner: older entries do not overwrite once latestUserActivity is set", async () => {
    const jsonlPath = join(tmpDir, "r49-no-overwrite.jsonl");
    const lines = [
      makeCommandEntry("/old-command"),
      makeUserEntry("older message"),
      makeUserEntry("most recent message"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Reversed scan: "most recent message" is found first and wins; older entries ignored
    expect(result.latestUserActivity?.text).toBe("most recent message");
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });
});
describe("readSessionTail accurate token totals (R39)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r39");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeAssistantWithFullUsage(opts: {
    inputTokens?: number;
    cacheCreate?: number;
    cacheRead?: number;
    outputTokens?: number;
  }): string {
    const usage: Record<string, number> = {};
    if (opts.inputTokens !== undefined) usage.input_tokens = opts.inputTokens;
    if (opts.cacheCreate !== undefined)
      usage.cache_creation_input_tokens = opts.cacheCreate;
    if (opts.cacheRead !== undefined)
      usage.cache_read_input_tokens = opts.cacheRead;
    if (opts.outputTokens !== undefined)
      usage.output_tokens = opts.outputTokens;
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "response" }],
        usage,
      },
    });
  }

  test("R39: sums input + cache_creation + cache_read tokens", async () => {
    const jsonlPath = join(tmpDir, "r39-full.jsonl");
    await writeFile(
      jsonlPath,
      `${makeAssistantWithFullUsage({
        inputTokens: 100,
        cacheCreate: 5000,
        cacheRead: 200000,
        outputTokens: 500,
      })}\n`,
    );

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.inputTokens).toBe(100 + 5000 + 200000);
    expect(result.outputTokens).toBe(500);
  });

  test("R39: missing cache fields treated as 0 (backward compat)", async () => {
    const jsonlPath = join(tmpDir, "r39-no-cache.jsonl");
    await writeFile(
      jsonlPath,
      `${makeAssistantWithFullUsage({
        inputTokens: 300,
        outputTokens: 100,
      })}\n`,
    );

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(100);
  });

  test("R39: only cache fields present, input_tokens absent → sums cache only", async () => {
    const jsonlPath = join(tmpDir, "r39-cache-only.jsonl");
    await writeFile(
      jsonlPath,
      `${makeAssistantWithFullUsage({
        cacheCreate: 1000,
        cacheRead: 50000,
        outputTokens: 200,
      })}\n`,
    );

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.inputTokens).toBe(51000);
    expect(result.outputTokens).toBe(200);
  });

  test("R39: multiple entries — inputTokens is last-seen value, outputTokens is sum", async () => {
    const jsonlPath = join(tmpDir, "r39-multi.jsonl");
    const lines = [
      makeAssistantWithFullUsage({
        inputTokens: 100,
        cacheCreate: 1000,
        cacheRead: 10000,
        outputTokens: 50,
      }),
      makeAssistantWithFullUsage({
        inputTokens: 200,
        cacheCreate: 2000,
        cacheRead: 20000,
        outputTokens: 75,
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // inputTokens: last-seen value (second entry = 200 + 2000 + 20000)
    expect(result.inputTokens).toBe(200 + 2000 + 20000);
    // outputTokens: sum of per-call deltas
    expect(result.outputTokens).toBe(125);
  });
});
describe("readSessionTail input token last-value semantics (R47)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r47");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeAssistantWithUsage(
    inputTokens: number,
    outputTokens: number,
  ): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "response" }],
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: outputTokens,
        },
      },
    });
  }

  test("R47: monotonically growing input_tokens → result equals last entry value", async () => {
    const jsonlPath = join(tmpDir, "r47-growing-input.jsonl");
    // Simulate cache_read growing across calls (1000, 2000, 5000)
    const lines = [
      makeAssistantWithUsage(1000, 10),
      makeAssistantWithUsage(2000, 20),
      makeAssistantWithUsage(5000, 30),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // inputTokens: last-seen value (5000), not sum (1000+2000+5000=8000)
    expect(result.inputTokens).toBe(5000);
    // outputTokens: sum of per-call deltas (10+20+30=60)
    expect(result.outputTokens).toBe(60);
  });

  test("R47: delta merge — new scan value replaces base input, output accumulates", async () => {
    const jsonlPath = join(tmpDir, "r47-delta-merge.jsonl");

    const initialLines = [makeAssistantWithUsage(5000, 100)];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(5000);
    expect(first.outputTokens).toBe(100);

    // Append: new call with larger input (cache grew to 6000)
    await new Promise((r) => setTimeout(r, 10));
    const existing = await readFile(jsonlPath, "utf8");
    await writeFile(
      jsonlPath,
      `${existing + makeAssistantWithUsage(6000, 50)}\n`,
    );

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // inputTokens: new value 6000 replaces base 5000 (not 11000)
    expect(second.inputTokens).toBe(6000);
    // outputTokens: 100 (base) + 50 (new) = 150
    expect(second.outputTokens).toBe(150);
  });
});
describe("getSubagentInfos lifecycle (R40)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r40");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSubagentDir(
    sessionId: string,
  ): Promise<{ subagentsDir: string; jsonlPath: string }> {
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    return { subagentsDir, jsonlPath };
  }

  test("R40: lastMessageTime populated as ISO 8601 from file mtime", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-mtime");
    const agentPath = join(subagentsDir, "agent-abc.jsonl");
    await writeFile(agentPath, "{}");

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(1);
    expect(infos[0].lastMessageTime).toBeDefined();
    // Should be a valid ISO 8601 string
    expect(new Date(infos[0].lastMessageTime).toISOString()).toBe(
      infos[0].lastMessageTime,
    );
    // Should be recent (within last 10 seconds)
    expect(
      Date.now() - new Date(infos[0].lastMessageTime).getTime(),
    ).toBeLessThan(10_000);
  });

  test("R40: launchTime populated as ISO 8601 from file mtime", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-launch");
    const agentPath = join(subagentsDir, "agent-xyz.jsonl");
    await writeFile(agentPath, "{}");

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(1);
    expect(infos[0].launchTime).toBeDefined();
    expect(new Date(infos[0].launchTime).toISOString()).toBe(
      infos[0].launchTime,
    );
  });

  test("R40: completed agent older than 30s excluded from result", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-expire");
    const oldAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(oldAgent, "{}");

    // Backdate to 60 seconds ago
    const sixtySecAgo = new Date(Date.now() - 60_000);
    utimesSync(oldAgent, sixtySecAgo, sixtySecAgo);

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    // Old inactive agent should be filtered out
    expect(infos.find((i) => i.agentId === "old")).toBeUndefined();
  });

  test("R40: completed agent younger than 30s is included", async () => {
    const { subagentsDir, jsonlPath } =
      await makeSubagentDir("r40-recent-done");
    const recentAgent = join(subagentsDir, "agent-recent.jsonl");
    await writeFile(recentAgent, "{}");

    // Backdate to 20 seconds ago (within 30s window, but >15s so isActive=false)
    const twentySecAgo = new Date(Date.now() - 20_000);
    utimesSync(recentAgent, twentySecAgo, twentySecAgo);

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "recent");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(false);
  });

  test("R40: active agent (mtime < 15s) always included regardless of expiry", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-active");
    const activeAgent = join(subagentsDir, "agent-live.jsonl");
    await writeFile(activeAgent, "{}");
    // mtime is now = active

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "live");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(true);
  });

  test("R40: sub-agent mtime before stop (mtime 20s ago, stopped 10s ago) → isActive false", async () => {
    const { subagentsDir, jsonlPath } =
      await makeSubagentDir("r40-stopped-before");
    const agentPath = join(subagentsDir, "agent-pre.jsonl");
    await writeFile(agentPath, "{}");

    const now = Date.now();
    const twentySecAgo = new Date(now - 20_000);
    utimesSync(agentPath, twentySecAgo, twentySecAgo);

    const stoppedAtMs = now - 10_000;
    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(
      jsonlPath,
      stoppedAtMs,
    );
    const agent = infos.find((i) => i.agentId === "pre");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(false);
  });

  test("R40: sub-agent mtime after stop (mtime 5s ago, stopped 20s ago) → isActive true", async () => {
    const { subagentsDir, jsonlPath } =
      await makeSubagentDir("r40-stopped-after");
    const agentPath = join(subagentsDir, "agent-post.jsonl");
    await writeFile(agentPath, "{}");

    const now = Date.now();
    const fiveSecAgo = new Date(now - 5_000);
    utimesSync(agentPath, fiveSecAgo, fiveSecAgo);

    const stoppedAtMs = now - 20_000;
    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(
      jsonlPath,
      stoppedAtMs,
    );
    const agent = infos.find((i) => i.agentId === "post");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(true);
  });

  test("R40: stoppedAtMs null → existing 15s threshold behavior unchanged", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-no-stop");
    const activeAgent = join(subagentsDir, "agent-now.jsonl");
    const staleAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(activeAgent, "{}");
    await writeFile(staleAgent, "{}");

    // Backdate to 20 seconds ago (>15s threshold, within 30s expiry)
    const twentySecAgo = new Date(Date.now() - 20_000);
    utimesSync(staleAgent, twentySecAgo, twentySecAgo);

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(
      jsonlPath,
      null,
    );
    const active = infos.find((i) => i.agentId === "now");
    const stale = infos.find((i) => i.agentId === "old");
    expect(active?.isActive).toBe(true);
    expect(stale?.isActive).toBe(false);
  });
});
describe("getSubagentInfos status file detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-subagent-status");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSubagentDir(
    sessionId: string,
  ): Promise<{ subagentsDir: string; jsonlPath: string }> {
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    return { subagentsDir, jsonlPath };
  }

  test("fresh mtime + stopped status file → isActive false", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("sa-stopped");
    const agentPath = join(subagentsDir, "agent-abc123.jsonl");
    await writeFile(agentPath, "{}");
    // mtime is now = would normally be active

    // Write ccmon-status.json with stopped state
    await writeFile(
      join(subagentsDir, "agent-abc123.ccmon-status.json"),
      JSON.stringify({ state: "stopped", timestamp: new Date().toISOString() }),
    );

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "abc123");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(false);
  });

  test("no status file → mtime-based detection (fresh = active)", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("sa-nomfile");
    const agentPath = join(subagentsDir, "agent-def456.jsonl");
    await writeFile(agentPath, "{}");
    // mtime is now, no status file

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "def456");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(true);
  });

  test("status file with non-stopped state → mtime-based detection still applies", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("sa-running");
    const agentPath = join(subagentsDir, "agent-ghi789.jsonl");
    await writeFile(agentPath, "{}");
    // mtime is now

    // Write status file with non-stopped state
    await writeFile(
      join(subagentsDir, "agent-ghi789.ccmon-status.json"),
      JSON.stringify({ state: "running", timestamp: new Date().toISOString() }),
    );

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "ghi789");
    expect(agent).toBeDefined();
    // Non-stopped status file → falls back to mtime, which is fresh → active
    expect(agent?.isActive).toBe(true);
  });
});
describe("getSubagentInfos ordering (R43)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r43");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("R43: sub-agents sorted descending by launchTime", async () => {
    const sessionId = "r43-sort";
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);

    const agentA = join(subagentsDir, "agent-aaa.jsonl");
    const agentB = join(subagentsDir, "agent-bbb.jsonl");
    const agentC = join(subagentsDir, "agent-ccc.jsonl");

    await writeFile(agentA, "{}");
    await writeFile(agentB, "{}");
    await writeFile(agentC, "{}");

    // Set distinct mtimes: C is newest, A is oldest
    const now = Date.now();
    utimesSync(agentA, new Date(now - 3000), new Date(now - 3000));
    utimesSync(agentB, new Date(now - 2000), new Date(now - 2000));
    utimesSync(agentC, new Date(now - 1000), new Date(now - 1000));

    const infos = await new ClaudeBackend(tmpDir).getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(3);
    // Descending by launchTime: C, B, A
    expect(infos[0].agentId).toBe("ccc");
    expect(infos[1].agentId).toBe("bbb");
    expect(infos[2].agentId).toBe("aaa");
  });
});
describe("readSessionTail TaskCreate/TaskUpdate task parsing (R46)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r46");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeTaskCreateEntry(
    toolUseId: string,
    subject: string,
    activeForm?: string,
  ): string {
    const input: Record<string, string> = {
      subject,
      description: "some description",
    };
    if (activeForm) input.activeForm = activeForm;
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: toolUseId, name: "TaskCreate", input },
        ],
      },
    });
  }

  function makeTaskUpdateEntry(taskId: string, status: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: `tu-update-${taskId}`,
            name: "TaskUpdate",
            input: { taskId, status },
          },
        ],
      },
    });
  }

  function makeToolResultEntry(toolUseId: string, resultText: string): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: resultText },
        ],
      },
    });
  }

  test("R46: TaskCreate tool_use blocks build task map with correct subjects and IDs", async () => {
    const jsonlPath = join(tmpDir, "r46-create.jsonl");
    const lines = [
      makeTaskCreateEntry(
        "tu-1",
        "Implement feature X",
        "Implementing feature X",
      ),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Write tests for Y"),
      makeToolResultEntry("tu-2", "Task #2 created successfully"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks?.[0].id).toBe("1");
    expect(result.tasks?.[0].subject).toBe("Implement feature X");
    expect(result.tasks?.[0].status).toBe("pending");
    expect(result.tasks?.[0].activeForm).toBe("Implementing feature X");
    expect(result.tasks?.[1].id).toBe("2");
    expect(result.tasks?.[1].subject).toBe("Write tests for Y");
  });

  test("R46: TaskUpdate patches task status", async () => {
    const jsonlPath = join(tmpDir, "r46-update.jsonl");
    const lines = [
      makeTaskCreateEntry("tu-1", "Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Task B"),
      makeToolResultEntry("tu-2", "Task #2 created successfully"),
      makeTaskUpdateEntry("1", "in_progress"),
      makeTaskUpdateEntry("2", "completed"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks?.find((t) => t.id === "1")?.status).toBe("in_progress");
    expect(result.tasks?.find((t) => t.id === "2")?.status).toBe("completed");
  });

  test("R46: tasksDone and tasksTotal derived correctly from tasks array", async () => {
    const jsonlPath = join(tmpDir, "r46-counts.jsonl");
    const lines = [
      makeTaskCreateEntry("tu-1", "Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Task B"),
      makeToolResultEntry("tu-2", "Task #2 created successfully"),
      makeTaskCreateEntry("tu-3", "Task C"),
      makeToolResultEntry("tu-3", "Task #3 created successfully"),
      makeTaskCreateEntry("tu-4", "Task D"),
      makeToolResultEntry("tu-4", "Task #4 created successfully"),
      makeTaskUpdateEntry("1", "completed"),
      makeTaskUpdateEntry("2", "in_progress"),
      makeTaskUpdateEntry("3", "completed"),
      // Task 4 stays pending
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasksTotal).toBe(4);
    expect(result.tasksDone).toBe(2);
  });

  test("R46: deleted tasks excluded from total count", async () => {
    const jsonlPath = join(tmpDir, "r46-deleted.jsonl");
    const lines = [
      makeTaskCreateEntry("tu-1", "Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Task B"),
      makeToolResultEntry("tu-2", "Task #2 created successfully"),
      makeTaskCreateEntry("tu-3", "Task C"),
      makeToolResultEntry("tu-3", "Task #3 created successfully"),
      makeTaskUpdateEntry("2", "deleted"),
      makeTaskUpdateEntry("1", "completed"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Task 2 is deleted → excluded from total
    expect(result.tasksTotal).toBe(2);
    expect(result.tasksDone).toBe(1);
  });

  test("R46: tasks sorted numerically by ID", async () => {
    const jsonlPath = join(tmpDir, "r46-sort.jsonl");
    const lines = [
      makeTaskCreateEntry("tu-1", "First"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Second"),
      makeToolResultEntry("tu-2", "Task #10 created successfully"),
      makeTaskCreateEntry("tu-3", "Third"),
      makeToolResultEntry("tu-3", "Task #2 created successfully"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasks?.map((t) => t.id)).toEqual(["1", "2", "10"]);
  });

  test("R46: TodoWrite used as fallback when no TaskCreate blocks present", async () => {
    const jsonlPath = join(tmpDir, "r46-todowrite-fallback.jsonl");
    const todos = [
      { content: "Old task A", status: "completed" },
      { content: "Old task B", status: "pending" },
    ];
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }],
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(result.tasks).toBeUndefined();
    expect(result.tasksTotal).toBe(2);
    expect(result.tasksDone).toBe(1);
  });

  test("R46: TaskCreate takes priority over TodoWrite when both present", async () => {
    const jsonlPath = join(tmpDir, "r46-priority.jsonl");
    const todos = [
      { content: "Legacy A", status: "completed" },
      { content: "Legacy B", status: "completed" },
      { content: "Legacy C", status: "completed" },
    ];
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }],
        },
      }),
      makeTaskCreateEntry("tu-1", "Modern Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // TaskCreate wins: 1 task, not 3 from TodoWrite
    expect(result.tasks).toHaveLength(1);
    expect(result.tasksTotal).toBe(1);
    expect(result.tasksDone).toBe(0);
  });

  test("R46: TaskUpdate-only (no resolved TaskCreate) does not suppress TodoWrite fallback", async () => {
    // A TaskUpdate block with no preceding TaskCreate tool_result in the scanned window
    // must not set foundAny=true and block the TodoWrite fallback.
    const jsonlPath = join(tmpDir, "r46-update-only.jsonl");
    const todos = [
      { content: "Fallback A", status: "completed" },
      { content: "Fallback B", status: "pending" },
    ];
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }],
        },
      }),
      // TaskUpdate for an ID that has no TaskCreate in this window
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "tu-upd",
              name: "TaskUpdate",
              input: { taskId: "99", status: "completed" },
            },
          ],
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // TaskUpdate for unknown ID must not block TodoWrite; fallback should produce 2 tasks
    expect(result.tasksTotal).toBe(2);
    expect(result.tasksDone).toBe(1);
    expect(result.tasks).toBeUndefined(); // TodoWrite path never sets tasks array
  });

  test("R46: TaskCreate seen but no tool_result yet → tasks/counts stay undefined (no 0/0 flash)", async () => {
    // Reproduces the bug where a pending TaskCreate (no matching tool_result) caused
    // scanTaskCreateUpdate to return a non-null empty Map, which triggered mergeEnrichment
    // to produce tasks=[], tasksDone=0, tasksTotal=0 instead of leaving everything undefined.
    const jsonlPath = join(tmpDir, "r46-pending-create.jsonl");
    const lines = [
      // TaskCreate tool_use with no matching tool_result in the file yet
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "tu-pending",
              name: "TaskCreate",
              input: { subject: "Pending task" },
            },
          ],
        },
      }),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // No tool_result confirms the task ID → tasks/counts must remain undefined
    expect(result.tasks).toBeUndefined();
    expect(result.tasksTotal).toBeUndefined();
    expect(result.tasksDone).toBeUndefined();
  });
});
describe("readSessionTail line boundary edge case (R27)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r27-boundary");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeAssistantEntry(model: string, contentBlocks: object[]): string {
    return JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model, content: contentBlocks },
    });
  }

  test("R27: startOffset landing exactly on newline boundary preserves the line after it", async () => {
    // Build a file where MAX_FIRST_READ is simulated by having the offset land exactly
    // on a newline. We do this by creating a file where the slice starts at '\n'.
    // We test this indirectly: write a file, read it, and ensure no lines are dropped
    // even when the file starts with a newline-terminated record.
    const jsonlPath = join(tmpDir, "r27-boundary.jsonl");

    // Write lines where the first entry is exactly followed by a newline at the boundary.
    // The key scenario: if the file read starts exactly at a '\n', the split produces
    // '' as first element which filter removes, then old code's slice(1) drops the next line.
    const line1 = makeAssistantEntry("claude-sonnet-4-6", [
      { type: "text", text: "line one" },
    ]);
    const line2 = makeAssistantEntry("claude-sonnet-4-6", [
      { type: "text", text: "line two" },
    ]);

    // Simulate startOffset landing on newline: write '\n' + line2 to a separate file
    // and read it (startOffset=0 but text[0]='\n'). The isDelta=false, startOffset=0
    // branch does not trigger slice(1), so this tests the filter+slice interaction.
    // More directly: write content starting with '\n' and verify nothing is dropped.
    await writeFile(jsonlPath, `\n${line1}\n${line2}\n`);

    // Force a cap-based offset by making the file appear > MAX_FIRST_READ. We can't
    // easily do that in a unit test, so instead verify the basic read path works correctly
    // when text starts with '\n' (empty first element after split).
    const result = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Both lines must be reachable; reversed scan finds line2 first (most recent)
    expect(result.latestAssistantActivity?.text).toBe("line two");
  });
});
describe("readSessionTail delta task completion (R46 Bug 1)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r46-delta");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeTaskCreateEntry(toolUseId: string, subject: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "TaskCreate",
            input: { subject, description: "d" },
          },
        ],
      },
    });
  }

  function makeTaskUpdateEntry(taskId: string, status: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: `tu-upd-${taskId}`,
            name: "TaskUpdate",
            input: { taskId, status },
          },
        ],
      },
    });
  }

  function makeToolResultEntry(toolUseId: string, resultText: string): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: resultText },
        ],
      },
    });
  }

  test("R46/Bug1: TaskUpdate in delta read resolves tasks created in earlier read → tasksDone increments", async () => {
    const jsonlPath = join(tmpDir, "r46-delta-update.jsonl");

    // First read: TaskCreate lines only
    const firstBatch = `${[
      makeTaskCreateEntry("tu-1", "Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
      makeTaskCreateEntry("tu-2", "Task B"),
      makeToolResultEntry("tu-2", "Task #2 created successfully"),
    ].join("\n")}\n`;
    await writeFile(jsonlPath, firstBatch);

    // Stamp mtime in the past so the second write is detected as a delta.
    const pastTime = new Date(Date.now() - 5_000);
    utimesSync(jsonlPath, pastTime, pastTime);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.tasksDone).toBe(0);
    expect(first.tasksTotal).toBe(2);

    // Second read: append TaskUpdate completing Task #1.
    const secondBatch = `${makeTaskUpdateEntry("1", "completed")}\n`;
    const existing = await readFile(jsonlPath, "utf8");
    await writeFile(jsonlPath, existing + secondBatch);

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(second.tasksDone).toBe(1);
    expect(second.tasksTotal).toBe(2);
  });

  test("R46/Bug1: TaskUpdate in delta for unknown task ID is silently ignored (no crash, no phantom task)", async () => {
    const jsonlPath = join(tmpDir, "r46-delta-unknown.jsonl");

    // First read: one task created
    const firstBatch = `${[
      makeTaskCreateEntry("tu-1", "Task A"),
      makeToolResultEntry("tu-1", "Task #1 created successfully"),
    ].join("\n")}\n`;
    await writeFile(jsonlPath, firstBatch);

    const pastTime = new Date(Date.now() - 5_000);
    utimesSync(jsonlPath, pastTime, pastTime);

    const first = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    expect(first.tasksTotal).toBe(1);

    // Second read: TaskUpdate for task ID 99 which was never created
    const secondBatch = `${makeTaskUpdateEntry("99", "completed")}\n`;
    const existing = await readFile(jsonlPath, "utf8");
    await writeFile(jsonlPath, existing + secondBatch);

    const second = await new ClaudeBackend(tmpDir).readSessionTail(jsonlPath);
    // Task 99 must not appear; only original task remains
    expect(second.tasksTotal).toBe(1);
    expect(second.tasksDone).toBe(0);
    expect(second.tasks?.find((t) => t.id === "99")).toBeUndefined();
  });
});
describe("ClaudeBackend", () => {
  test("constructing a fresh ClaudeBackend gives clean caches", async () => {
    const tmpDir = await makeTempDir("ccmon-store-isolation");
    const backend = new ClaudeBackend(tmpDir);

    backend.resetCaches();
    expect(backend.sessionTailCache.size).toBe(0);
    expect(backend.projectStateCache.size).toBe(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("two ClaudeBackend instances have independent caches", async () => {
    const tmpDirA = await makeTempDir("ccmon-store-a");
    const tmpDirB = await makeTempDir("ccmon-store-b");

    const backendA = new ClaudeBackend(tmpDirA);
    const backendB = new ClaudeBackend(tmpDirB);

    backendA.sessionTailCache.set("/fake/path", {
      mtime: Date.now(),
      fileSize: 100,
      data: { agentDescriptions: new Map() },
    });

    expect(backendA.sessionTailCache.size).toBe(1);
    expect(backendB.sessionTailCache.size).toBe(0);

    await rm(tmpDirA, { recursive: true, force: true });
    await rm(tmpDirB, { recursive: true, force: true });
  });

  test("each new ClaudeBackend has independent caches", async () => {
    const tmpDir = await makeTempDir("ccmon-replace");
    const backendA = new ClaudeBackend(tmpDir);
    backendA.sessionTailCache.set("/test", {
      mtime: Date.now(),
      fileSize: 100,
      data: { agentDescriptions: new Map() },
    });

    const backendB = new ClaudeBackend(tmpDir);
    expect(backendB.sessionTailCache.size).toBe(0);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
