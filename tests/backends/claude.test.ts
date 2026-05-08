import { utimesSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaudeBackend } from "../../src/backends/claude";
import { makeTempDir } from "../_helpers";

function makeFirstLine(cwd: string, sessionId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
  });
}

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
    const state = await backend.buildProjectState(projects[0]);

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
