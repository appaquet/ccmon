import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLOSED_PROJECT_TTL_MS,
  disambiguateProjectNames,
  filterStaleProjects,
  scanProjects,
} from "../src/project-utils.ts";
import type { SessionState } from "../src/session-core.ts";
import type { ProjectState } from "../src/types.ts";
import { makeFirstLine, makeTempDir } from "./_helpers.ts";

// ─── scanProjects ────────────────────────────────────────────────────────────

describe("scanProjects", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-scan");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("happy path: returns correct projectDir, cwd, projectName, sessionId, latestJSONL", async () => {
    const projDir = join(tmpDir, "-home-user-myproject");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "session1.jsonl"),
      `${makeFirstLine("/home/user/myproject", "abc123")}\n`,
    );

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].projectDir).toBe("-home-user-myproject");
    expect(results[0].cwd).toBe("/home/user/myproject");
    expect(results[0].projectName).toBe("myproject");
    expect(results[0].sessionId).toBe("abc123");
    expect(results[0].latestJSONL).toBe(join(projDir, "session1.jsonl"));
  });

  test("multiple JSONL files: picks most recently modified one", async () => {
    const projDir = join(tmpDir, "-home-user-proj");
    await mkdir(projDir, { recursive: true });

    const older = join(projDir, "old.jsonl");
    await writeFile(
      older,
      `${makeFirstLine("/home/user/proj", "old-session")}\n`,
    );

    const pastTime = new Date(Date.now() - 60_000);
    await utimes(older, pastTime, pastTime);

    const newer = join(projDir, "new.jsonl");
    await writeFile(
      newer,
      `${makeFirstLine("/home/user/proj", "new-session")}\n`,
    );

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("new-session");
    expect(results[0].latestJSONL).toBe(newer);
  });

  test("no JSONL files in subdir: skips that project", async () => {
    const projDir = join(tmpDir, "-home-user-nojsonl");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "ccmon-status.json"), "{}");

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test("corrupt JSONL (invalid JSON first line): skips that project", async () => {
    const projDir = join(tmpDir, "-home-user-corrupt");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "session.jsonl"), "not valid json\n");

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test("subagents/ subdir in project dir: ignored as a project dir", async () => {
    const subagentsDir = join(tmpDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      join(subagentsDir, "session.jsonl"),
      `${makeFirstLine("/some/path", "sa-session")}\n`,
    );

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test("empty projects dir: returns empty array", async () => {
    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(0);
  });

  test("multiple valid projects: returns all", async () => {
    for (const name of ["-home-user-proj-a", "-home-user-proj-b"]) {
      const projDir = join(tmpDir, name);
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, "session.jsonl"),
        `${makeFirstLine(`/home/user/${name}`, `id-${name}`)}\n`,
      );
    }

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(2);
  });

  test("no sessions-index.json, first JSONL line >512 bytes: project is not dropped", async () => {
    const projDir = join(tmpDir, "-home-user-longfirstline");
    await mkdir(projDir, { recursive: true });

    const longContent = "x".repeat(600);
    const firstLineObj = {
      timestamp: new Date().toISOString(),
      sessionId: "long-line-session",
      cwd: "/home/user/longfirstline",
      message: { role: "user", content: longContent },
    };
    const firstLine = JSON.stringify(firstLineObj);

    expect(firstLine.length).toBeGreaterThan(512);

    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("long-line-session");
    expect(results[0].cwd).toBe("/home/user/longfirstline");
  });

  test("readFirstLine scans past non-cwd lines to find cwd+sessionId", async () => {
    const projDir = join(tmpDir, "-home-user-multiline");
    await mkdir(projDir, { recursive: true });

    const line1 = JSON.stringify({
      type: "permission-mode",
      permissionMode: "acceptEdits",
      sessionId: "test-1",
    });
    const line2 = JSON.stringify({
      cwd: "/home/user/multiline",
      sessionId: "test-1",
      type: "user",
    });
    await writeFile(join(projDir, "session.jsonl"), `${line1}\n${line2}\n`);

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].cwd).toBe("/home/user/multiline");
    expect(results[0].sessionId).toBe("test-1");
  });

  test("readFirstLine returns cwd from first line when present", async () => {
    const projDir = join(tmpDir, "-home-user-firstline");
    await mkdir(projDir, { recursive: true });

    const line1 = JSON.stringify({
      cwd: "/home/user/firstline",
      sessionId: "fl-sess",
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(projDir, "session.jsonl"), `${line1}\n`);

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].cwd).toBe("/home/user/firstline");
    expect(results[0].sessionId).toBe("fl-sess");
  });
});

// ─── filterStaleProjects NaN guard ───────────────────────────────────────────

describe("filterStaleProjects NaN guard (R18)", () => {
  function makeProject(lastUpdated: string | null): ProjectState {
    return {
      projectDir: "dir",
      cwd: "/home/user/proj",
      projectName: "proj",
      sessionId: "sid",
      latestJSONL: "/home/user/proj/session.jsonl",
      source: "claude",
      state: "stopped",
      lastUpdated,
    };
  }

  test("R18: invalid lastUpdated string (NaN) keeps project instead of silently dropping it", () => {
    const projects = [makeProject("not-a-date")];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(1);
  });
});

// ─── filterStaleProjects ──────────────────────────────────────────────────────

describe("filterStaleProjects", () => {
  function makeProject(lastUpdated: string | null): ProjectState {
    return {
      projectDir: "dir",
      cwd: "/home/user/proj",
      projectName: "proj",
      sessionId: "sid",
      latestJSONL: "/home/user/proj/session.jsonl",
      source: "claude",
      state: "stopped",
      lastUpdated,
    };
  }

  test("recent lastUpdated: project is kept", () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const projects = [makeProject(recent)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(1);
  });

  test("old lastUpdated: project is removed", () => {
    const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const projects = [makeProject(old)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(0);
  });

  test("null lastUpdated: project is removed", () => {
    const projects = [makeProject(null)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(0);
  });

  test("maxInactivityHours = 0: all projects returned (filter disabled)", () => {
    const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const projects = [makeProject(null), makeProject(old)];
    const result = filterStaleProjects(projects, 0);
    expect(result).toHaveLength(2);
  });

  test("maxInactivityHours = Infinity: all projects returned (filter disabled)", () => {
    const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const projects = [makeProject(null), makeProject(old)];
    const result = filterStaleProjects(projects, Infinity);
    expect(result).toHaveLength(2);
  });
});

// ─── closed state (Phase 35) ─────────────────────────────────────────────────

describe("closed state", () => {
  function makeProject(
    state: SessionState,
    lastUpdated: string | null,
  ): ProjectState {
    return {
      projectDir: "dir",
      cwd: "/home/user/proj",
      projectName: "proj",
      sessionId: "sid",
      latestJSONL: "/home/user/proj/session.jsonl",
      source: "claude",
      state,
      lastUpdated,
    };
  }

  test("filterStaleProjects: closed project older than 1 min is removed", () => {
    const old = new Date(
      Date.now() - CLOSED_PROJECT_TTL_MS - 1000,
    ).toISOString();
    const projects = [makeProject("closed", old)];
    const result = filterStaleProjects(projects, 3);
    expect(result).toHaveLength(0);
  });

  test("filterStaleProjects: closed project younger than 1 min is kept", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const projects = [makeProject("closed", recent)];
    const result = filterStaleProjects(projects, 3);
    expect(result).toHaveLength(1);
  });

  test("filterStaleProjects: stopped project within maxInactivityHours is kept", () => {
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    const projects = [makeProject("stopped", recent)];
    const result = filterStaleProjects(projects, 3);
    expect(result).toHaveLength(1);
  });

  test("filterStaleProjects: closed project is removed by short TTL even when within maxInactivityHours", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const projects = [makeProject("closed", fiveMinAgo)];
    const result = filterStaleProjects(projects, 3);
    expect(result).toHaveLength(0);
  });
});

// ─── disambiguateProjectNames ─────────────────────────────────────────────────

function makeProjectState(cwd: string): ProjectState {
  return {
    projectDir: cwd.replace(/\//g, "-"),
    cwd,
    projectName: cwd.split("/").at(-1) ?? cwd,
    sessionId: "test-session",
    latestJSONL: `${cwd}/session.jsonl`,
    source: "claude",
    state: "stopped",
    lastUpdated: null,
  };
}

describe("disambiguateProjectNames", () => {
  test("two projects with same basename, different parents", () => {
    const projects = [
      makeProjectState("/home/user/projectA/backend"),
      makeProjectState("/home/user/projectB/backend"),
    ];
    disambiguateProjectNames(projects);
    expect(projects[0].projectName).toBe("projectA/backend");
    expect(projects[1].projectName).toBe("projectB/backend");
  });

  test("three projects sharing basename, need 3 segments to disambiguate", () => {
    const projects = [
      makeProjectState("/a/x/backend"),
      makeProjectState("/b/x/backend"),
      makeProjectState("/c/y/backend"),
    ];
    disambiguateProjectNames(projects);
    expect(projects[0].projectName).toBe("a/x/backend");
    expect(projects[1].projectName).toBe("b/x/backend");
    expect(projects[2].projectName).toBe("c/y/backend");
  });

  test("mix of duplicate and unique basenames", () => {
    const projects = [
      makeProjectState("/home/user/projectA/backend"),
      makeProjectState("/home/user/projectB/backend"),
      makeProjectState("/home/user/frontend"),
    ];
    disambiguateProjectNames(projects);
    expect(projects[0].projectName).toBe("projectA/backend");
    expect(projects[1].projectName).toBe("projectB/backend");
    expect(projects[2].projectName).toBe("frontend");
  });

  test("single project: no disambiguation applied", () => {
    const projects = [makeProjectState("/home/user/myapp")];
    disambiguateProjectNames(projects);
    expect(projects[0].projectName).toBe("myapp");
  });

  test("two projects with identical cwd do not cause infinite loop", () => {
    const A = makeProjectState("/home/user/myproject");
    const B = makeProjectState("/home/user/myproject");
    B.source = "opencode";
    disambiguateProjectNames([A, B]);
    expect(A.projectName).toBe("myproject");
    expect(B.projectName).toBe("myproject");
  });

  test("re-run resets stale expanded names when a collision is resolved", () => {
    const a = makeProjectState("/home/user/projectA/backend");
    const b = makeProjectState("/home/user/projectB/backend");

    disambiguateProjectNames([a, b]);
    expect(a.projectName).toBe("projectA/backend");
    expect(b.projectName).toBe("projectB/backend");

    a.projectName = "backend";

    disambiguateProjectNames([a]);
    expect(a.projectName).toBe("backend");
  });
});
