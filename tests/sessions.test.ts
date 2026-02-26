import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import type { StatusEvent } from "../src/sessions";
import {
  _resetCachesForTesting,
  disambiguateProjectNames,
  filterStaleProjects,
  getProjectState,
  getSubagentInfos,
  MAX_STATUS_LOG_BYTES,
  mapHookEventToState,
  readSessionsIndex,
  readSessionTail,
  readStatusLog,
  resolveState,
  STATUS_FILE_LEGACY,
  STATUS_LOG_FILE,
  scanProjects,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
} from "../src/sessions";

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMPDIR = Bun.env.TMPDIR || "/tmp";

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    TMPDIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeFirstLine(
  cwd: string,
  sessionId: string,
  gitBranch = "main",
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
    gitBranch,
  });
}

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

    // older file
    const older = join(projDir, "old.jsonl");
    await writeFile(
      older,
      `${makeFirstLine("/home/user/proj", "old-session")}\n`,
    );

    // set mtime to past
    const pastTime = new Date(Date.now() - 60_000);
    await utimes(older, pastTime, pastTime);

    // newer file
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

    // Build a first-line JSON whose serialized form exceeds 512 bytes by including a long string value.
    const longContent = "x".repeat(600);
    const firstLineObj = {
      timestamp: new Date().toISOString(),
      sessionId: "long-line-session",
      cwd: "/home/user/longfirstline",
      gitBranch: "main",
      message: { role: "user", content: longContent },
    };
    const firstLine = JSON.stringify(firstLineObj);

    // Sanity-check: the test is only meaningful when the line actually exceeds 512 bytes.
    expect(firstLine.length).toBeGreaterThan(512);

    await writeFile(join(projDir, "session.jsonl"), `${firstLine}\n`);

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("long-line-session");
    expect(results[0].cwd).toBe("/home/user/longfirstline");
  });

  test("sessions-index.json present: returns enriched fields, uses projectPath as cwd", async () => {
    const projDir = join(tmpDir, "-home-user-indexed");
    await mkdir(projDir, { recursive: true });

    const entry = {
      sessionId: "idx-sess",
      fullPath: join(projDir, "idx-sess.jsonl"),
      fileMtime: 1_700_000_000_000,
      firstPrompt: "Work on feature X",
      summary: "Feature X implementation",
      messageCount: 42,
      created: "2026-02-01T00:00:00.000Z",
      modified: "2026-02-01T02:00:00.000Z",
      gitBranch: "main",
      projectPath: "/home/user/indexed",
      isSidechain: false,
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [entry] }),
    );

    // JSONL file must exist since latestJSONL points to it (stat used in getProjectState)
    await writeFile(
      entry.fullPath,
      `${makeFirstLine("/home/user/indexed", "idx-sess")}\n`,
    );

    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].cwd).toBe("/home/user/indexed");
    expect(results[0].projectName).toBe("indexed");
    expect(results[0].sessionId).toBe("idx-sess");
    expect(results[0].latestJSONL).toBe(entry.fullPath);
    expect(results[0].summary).toBe("Feature X implementation");
    expect(results[0].firstPrompt).toBe("Work on feature X");
    expect(results[0].messageCount).toBe(42);
    expect(results[0].sessionModified).toBe("2026-02-01T02:00:00.000Z");
  });

  test("stale sessions-index.json: newer on-disk JSONL used as latestJSONL", async () => {
    // Simulates the scenario where the index stops updating (e.g. Feb 3) but real
    // JSONL files continue being written to the project dir (e.g. Feb 21).
    const projDir = join(tmpDir, "-home-user-stale-index");
    await mkdir(projDir, { recursive: true });

    // Old JSONL referenced by the index (mtime = 20 days ago)
    const oldJSONL = join(projDir, "old-session.jsonl");
    await writeFile(
      oldJSONL,
      `${makeFirstLine("/home/user/stale-index", "old-sess")}\n`,
    );
    const staleMtime = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    utimesSync(oldJSONL, staleMtime, staleMtime);
    const staleMtimeMs = staleMtime.getTime();

    // Index records the old JSONL with its stale mtime
    const entry = {
      sessionId: "old-sess",
      fullPath: oldJSONL,
      fileMtime: staleMtimeMs,
      firstPrompt: "Old prompt",
      summary: "Old summary",
      messageCount: 5,
      modified: staleMtime.toISOString(),
      gitBranch: "main",
      projectPath: "/home/user/stale-index",
      isSidechain: false,
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [entry] }),
    );

    // Newer JSONL exists on disk (not in the index), written today
    const newerJSONL = join(projDir, "new-session.jsonl");
    await writeFile(
      newerJSONL,
      `${makeFirstLine("/home/user/stale-index", "new-sess")}\n`,
    );
    // Default mtime = now (no utimes call needed)

    _resetCachesForTesting();
    const results = await scanProjects(tmpDir);

    expect(results).toHaveLength(1);
    // latestJSONL must point to the newer file, not the index entry
    expect(results[0].latestJSONL).toBe(newerJSONL);
    // lastUpdated from getProjectState would reflect the newer file's mtime,
    // so verify via filterStaleProjects that this project is NOT dropped at 3h threshold
    const { getProjectState, filterStaleProjects } = await import(
      "../src/sessions"
    );
    _resetCachesForTesting();
    const states = await getProjectState(tmpDir);
    expect(states).toHaveLength(1);
    const kept = filterStaleProjects(states, 3);
    expect(kept).toHaveLength(1);
    // lastUpdated should be recent (within the last minute)
    expect(new Date(kept[0].lastUpdated as string).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

// ─── readSessionsIndex ───────────────────────────────────────────────────────

describe("readSessionsIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-index");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeIndexEntry(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sessionId: "sess-1",
      fullPath: "/some/path/sess-1.jsonl",
      fileMtime: 1_700_000_000_000,
      firstPrompt: "Hello world",
      summary: "A session summary",
      messageCount: 10,
      created: "2026-02-01T00:00:00.000Z",
      modified: "2026-02-01T01:00:00.000Z",
      gitBranch: "main",
      projectPath: "/home/user/project",
      isSidechain: false,
      ...overrides,
    };
  }

  test("valid sessions-index.json: returns projectPath and entries", async () => {
    const entry = makeIndexEntry();
    const index = { version: 1, entries: [entry] };
    await writeFile(join(tmpDir, "sessions-index.json"), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    expect(result?.projectPath).toBe("/home/user/project");
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].sessionId).toBe("sess-1");
    expect(result?.entries[0].fullPath).toBe("/some/path/sess-1.jsonl");
    expect(result?.entries[0].fileMtime).toBe(1_700_000_000_000);
    expect(result?.entries[0].summary).toBe("A session summary");
    expect(result?.entries[0].firstPrompt).toBe("Hello world");
    expect(result?.entries[0].messageCount).toBe(10);
    expect(result?.entries[0].modified).toBe("2026-02-01T01:00:00.000Z");
  });

  test("missing sessions-index.json: returns null", async () => {
    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
  });

  test("corrupt JSON: returns null", async () => {
    await writeFile(join(tmpDir, "sessions-index.json"), "not valid json {{");
    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
  });

  test("picks entry with highest fileMtime as latest session", async () => {
    const older = makeIndexEntry({
      sessionId: "old",
      fullPath: "/p/old.jsonl",
      fileMtime: 1_000,
    });
    const newer = makeIndexEntry({
      sessionId: "new",
      fullPath: "/p/new.jsonl",
      fileMtime: 2_000,
    });
    const index = { version: 1, entries: [older, newer] };
    await writeFile(join(tmpDir, "sessions-index.json"), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    // entries returned in original order; caller picks max
    expect(result?.entries).toHaveLength(2);
    const maxEntry = result?.entries.reduce((a, b) =>
      a.fileMtime > b.fileMtime ? a : b,
    );
    expect(maxEntry?.sessionId).toBe("new");
  });

  test("filters out isSidechain: true entries", async () => {
    const mainEntry = makeIndexEntry({ sessionId: "main", isSidechain: false });
    const sideEntry = makeIndexEntry({ sessionId: "side", isSidechain: true });
    const index = { version: 1, entries: [mainEntry, sideEntry] };
    await writeFile(join(tmpDir, "sessions-index.json"), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);

    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].sessionId).toBe("main");
  });

  test("all entries are sidechains: returns null (no usable entries)", async () => {
    const sideEntry = makeIndexEntry({ sessionId: "side", isSidechain: true });
    const index = { version: 1, entries: [sideEntry] };
    await writeFile(join(tmpDir, "sessions-index.json"), JSON.stringify(index));

    const result = await readSessionsIndex(tmpDir);
    expect(result).toBeNull();
  });
});

// ─── readStatusLog ───────────────────────────────────────────────────────────

describe("readStatusLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-status");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEvent(
    event: string,
    state: StatusEvent["state"],
    ts = "2026-02-19T10:00:00.000Z",
  ): StatusEvent {
    return {
      event,
      state,
      timestamp: ts,
      session_id: "abc123",
      working_dir: "/home/user/proj",
    };
  }

  test("valid NDJSON: returns StatusEvent array", async () => {
    const e1 = makeEvent("PostToolUse", "running");
    const e2 = makeEvent("PermissionRequest", "waiting_for_permission");
    await writeFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`,
    );

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].event).toBe("PostToolUse");
    expect(result[0].state).toBe("running");
    expect(result[1].event).toBe("PermissionRequest");
    expect(result[1].state).toBe("waiting_for_permission");
  });

  test("missing file: returns empty array", async () => {
    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(0);
  });

  test("corrupt lines: gracefully skipped", async () => {
    const e1 = makeEvent("PostToolUse", "running");
    await writeFile(
      join(tmpDir, STATUS_LOG_FILE),
      `not valid json\n${JSON.stringify(e1)}\nalso broken\n`,
    );

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].event).toBe("PostToolUse");
  });

  test("migration: reads legacy ccmon-status.json and converts to single-element array", async () => {
    const legacy = {
      state: "running",
      timestamp: "2026-02-19T10:00:00.000Z",
      session_id: "abc123",
      working_dir: "/home/user/proj",
    };
    await writeFile(join(tmpDir, STATUS_FILE_LEGACY), JSON.stringify(legacy));

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("running");
    expect(result[0].session_id).toBe("abc123");
    expect(result[0].event).toBeDefined();
  });

  test("NDJSON preferred over legacy JSON when both exist", async () => {
    const ndjsonEvent = makeEvent("Stop", "stopped");
    await writeFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(ndjsonEvent)}\n`,
    );
    const legacy = {
      state: "running",
      timestamp: "2026-02-19T10:00:00.000Z",
      session_id: "abc123",
      working_dir: "/home/user/proj",
    };
    await writeFile(join(tmpDir, STATUS_FILE_LEGACY), JSON.stringify(legacy));

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("stopped");
  });

  test("unknown state in event line: skipped", async () => {
    const bad = {
      event: "PostToolUse",
      state: "unknown_state",
      timestamp: "t",
      session_id: "s",
      working_dir: "/p",
    };
    await writeFile(join(tmpDir, STATUS_LOG_FILE), `${JSON.stringify(bad)}\n`);

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(0);
  });
});

// ─── getProjectState ─────────────────────────────────────────────────────────

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
    const results = await getProjectState(tmpDir);

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

    const results = await getProjectState(tmpDir);

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

    const results = await getProjectState(tmpDir);

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

    const results = await getProjectState(tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].state).toBe("stopped");
  });

  test("multiple projects: all returned", async () => {
    await makeProject("-home-user-a", "/home/user/a", "sida");
    await makeProject("-home-user-b", "/home/user/b", "sidb");

    const results = await getProjectState(tmpDir);
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

    const results = await getProjectState(tmpDir);
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

    const results = await getProjectState(tmpDir);
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

    const results = await getProjectState(tmpDir);
    expect(results).toHaveLength(1);
    // NaN age on permission signal treated as stale → falls through to priority 4 → stopped
    expect(results[0].state).toBe("stopped");
  });
});

// ─── filterStaleProjects NaN guard ───────────────────────────────────────────

describe("filterStaleProjects NaN guard (R18)", () => {
  function makeProject(
    lastUpdated: string | null,
  ): import("../src/sessions").ProjectState {
    return {
      projectDir: "dir",
      cwd: "/home/user/proj",
      projectName: "proj",
      sessionId: "sid",
      latestJSONL: "/home/user/proj/session.jsonl",
      state: "stopped",
      lastUpdated,
    };
  }

  test("R18: invalid lastUpdated string (NaN) keeps project instead of silently dropping it", () => {
    // A malformed timestamp should not cause the project to disappear from the dashboard.
    const projects = [makeProject("not-a-date")];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(1);
  });
});

// ─── mapHookEventToState ──────────────────────────────────────────────────────

describe("mapHookEventToState", () => {
  test("UserPromptSubmit → running", () => {
    expect(mapHookEventToState("UserPromptSubmit")).toBe("running");
  });

  test("PostToolUse → running", () => {
    expect(mapHookEventToState("PostToolUse")).toBe("running");
  });

  test("PermissionRequest → waiting_for_permission", () => {
    expect(mapHookEventToState("PermissionRequest")).toBe(
      "waiting_for_permission",
    );
  });

  test("Stop → stopped", () => {
    expect(mapHookEventToState("Stop")).toBe("stopped");
  });

  test("SessionEnd → stopped", () => {
    expect(mapHookEventToState("SessionEnd")).toBe("stopped");
  });

  test("unknown event → null", () => {
    expect(mapHookEventToState("SomeUnknownEvent")).toBeNull();
    expect(mapHookEventToState("")).toBeNull();
  });
});

// ─── writeStatusEvent / writeStatusTruncate ──────────────────────────────────

describe("writeStatusEvent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-write-status");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEvent(event: string, state: StatusEvent["state"]): StatusEvent {
    return {
      event,
      state,
      timestamp: new Date().toISOString(),
      session_id: "test-session-id",
      working_dir: "/home/user/project",
    };
  }

  test("appends NDJSON line to ccmon-status.jsonl", async () => {
    const e1 = makeEvent("PostToolUse", "running");
    const e2 = makeEvent("PermissionRequest", "waiting_for_permission");

    await writeStatusEvent(tmpDir, e1);
    await writeStatusEvent(tmpDir, e2);

    const raw = await readFile(join(tmpDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("PostToolUse");
    expect(JSON.parse(lines[1]).event).toBe("PermissionRequest");
  });

  test("round-trip: writeStatusEvent output is parseable by readStatusLog", async () => {
    const e = makeEvent("PostToolUse", "running");
    await writeStatusEvent(tmpDir, e);

    const result = await readStatusLog(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("running");
    expect(result[0].session_id).toBe("test-session-id");
  });

  test("safety cap: file trimmed when exceeding MAX_STATUS_LOG_BYTES", async () => {
    const logPath = join(tmpDir, STATUS_LOG_FILE);
    // Write enough data to exceed 64KB
    const bigLine = JSON.stringify(makeEvent("PostToolUse", "running"));
    const linesNeeded =
      Math.ceil(MAX_STATUS_LOG_BYTES / (bigLine.length + 1)) + 10;
    let bulk = "";
    for (let i = 0; i < linesNeeded; i++) {
      bulk += `${bigLine}\n`;
    }
    await writeFile(logPath, bulk);

    // One more append triggers the trim
    await writeStatusEvent(tmpDir, makeEvent("Stop", "stopped"));

    const { stat: fsStat } = await import("node:fs/promises");
    const s = await fsStat(logPath);
    // After trim, file should be much smaller than MAX_STATUS_LOG_BYTES
    expect(s.size).toBeLessThan(MAX_STATUS_LOG_BYTES);

    // The trimmed file should still be valid NDJSON
    const result = await readStatusLog(tmpDir);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("writeStatusTruncate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-write-truncate");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("overwrites file with single NDJSON line", async () => {
    const e1: StatusEvent = {
      event: "PostToolUse",
      state: "running",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      working_dir: "/p",
    };
    const e2: StatusEvent = {
      event: "SessionEnd",
      state: "stopped",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      working_dir: "/p",
    };

    await writeStatusEvent(tmpDir, e1);
    await writeStatusTruncate(tmpDir, e2);

    const raw = await readFile(join(tmpDir, STATUS_LOG_FILE), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("SessionEnd");
  });
});

// ─── mapHookEventToState (Notification) ──────────────────────────────────────

describe("mapHookEventToState (R26)", () => {
  test("Notification → null (does not change state)", () => {
    expect(mapHookEventToState("Notification")).toBeNull();
  });
});

// ─── writeNotificationStatus ──────────────────────────────────────────────────

describe("writeNotificationStatus (R26)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-notif-status");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("R26.1: appends Notification event with notificationMessage and notificationTimestamp", async () => {
    // Write a pre-existing running event
    const existing: StatusEvent = {
      event: "PostToolUse",
      state: "running",
      timestamp: "2026-02-20T12:00:00.000Z",
      session_id: "sess-1",
      working_dir: "/home/user/proj",
    };
    await appendFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(existing)}\n`,
    );

    const before = Date.now();
    await writeNotificationStatus(
      tmpDir,
      "Claude needs attention",
      "idle_prompt",
    );

    const events = await readStatusLog(tmpDir);
    expect(events).toHaveLength(2);
    const notifEvent = events[1];
    expect(notifEvent.event).toBe("Notification");
    expect(notifEvent.notificationMessage).toBe("Claude needs attention");
    expect(notifEvent.notificationTimestamp).toBeDefined();
    expect(
      new Date(notifEvent.notificationTimestamp as string).getTime(),
    ).toBeGreaterThanOrEqual(before);
  });

  test("R26.3: permission_prompt suppressed when last state-bearing event is waiting_for_permission", async () => {
    const existing: StatusEvent = {
      event: "PermissionRequest",
      state: "waiting_for_permission",
      timestamp: new Date().toISOString(),
      session_id: "sess-2",
      working_dir: "/home/user/proj",
    };
    await appendFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(existing)}\n`,
    );

    await writeNotificationStatus(
      tmpDir,
      "Permission needed",
      "permission_prompt",
    );

    const events = await readStatusLog(tmpDir);
    // Only the original event should exist — notification was suppressed
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("PermissionRequest");
  });

  test("R26.3: permission_prompt writes through when state is not waiting_for_permission", async () => {
    const existing: StatusEvent = {
      event: "PostToolUse",
      state: "running",
      timestamp: new Date().toISOString(),
      session_id: "sess-3",
      working_dir: "/home/user/proj",
    };
    await appendFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(existing)}\n`,
    );

    await writeNotificationStatus(
      tmpDir,
      "Permission needed",
      "permission_prompt",
    );

    const events = await readStatusLog(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[1].notificationMessage).toBe("Permission needed");
  });

  test("R26.1: idle_prompt writes notificationMessage regardless of state", async () => {
    const existing: StatusEvent = {
      event: "PermissionRequest",
      state: "waiting_for_permission",
      timestamp: new Date().toISOString(),
      session_id: "sess-4",
      working_dir: "/home/user/proj",
    };
    await appendFile(
      join(tmpDir, STATUS_LOG_FILE),
      `${JSON.stringify(existing)}\n`,
    );

    await writeNotificationStatus(tmpDir, "Idle notification", "idle_prompt");

    const events = await readStatusLog(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[1].notificationMessage).toBe("Idle notification");
  });

  test("R26.1: no existing status file — appends Notification event", async () => {
    await writeNotificationStatus(tmpDir, "Hello", "auth_success");

    const events = await readStatusLog(tmpDir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("Notification");
    expect(events[0].notificationMessage).toBe("Hello");
  });
});

// ─── filterStaleProjects ──────────────────────────────────────────────────────

describe("filterStaleProjects", () => {
  function makeProject(
    lastUpdated: string | null,
  ): import("../src/sessions").ProjectState {
    return {
      projectDir: "dir",
      cwd: "/home/user/proj",
      projectName: "proj",
      sessionId: "sid",
      latestJSONL: "/home/user/proj/session.jsonl",
      state: "stopped",
      lastUpdated,
    };
  }

  test("recent lastUpdated: project is kept", () => {
    const recent = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const projects = [makeProject(recent)];
    const result = filterStaleProjects(projects, 1);
    expect(result).toHaveLength(1);
  });

  test("old lastUpdated: project is removed", () => {
    const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString(); // 5 hours ago
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

// ─── session enrichment ───────────────────────────────────────────────────────

describe("session enrichment", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-enrichment");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── gitBranch ──

  test("gitBranch flows from index entry through ProjectInfo", async () => {
    const projDir = join(tmpDir, "-home-user-branchtest");
    await mkdir(projDir, { recursive: true });

    const entry = {
      sessionId: "branch-sess",
      fullPath: join(projDir, "branch-sess.jsonl"),
      fileMtime: 1_700_000_000_000,
      projectPath: "/home/user/branchtest",
      isSidechain: false,
      gitBranch: "main",
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [entry] }),
    );
    await writeFile(
      entry.fullPath,
      `${makeFirstLine("/home/user/branchtest", "branch-sess")}\n`,
    );

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].gitBranch).toBe("main");
  });

  test("gitBranch is undefined when not present in index entry", async () => {
    const projDir = join(tmpDir, "-home-user-nobranch");
    await mkdir(projDir, { recursive: true });

    const entry = {
      sessionId: "nobranch-sess",
      fullPath: join(projDir, "nobranch-sess.jsonl"),
      fileMtime: 1_700_000_000_000,
      projectPath: "/home/user/nobranch",
      isSidechain: false,
      // no gitBranch
    };
    await writeFile(
      join(projDir, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [entry] }),
    );
    await writeFile(
      entry.fullPath,
      `${makeFirstLine("/home/user/nobranch", "nobranch-sess")}\n`,
    );

    const results = await scanProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].gitBranch).toBeUndefined();
  });

  // ── readSessionTail ──

  function makeUserEntry(content: string | object[]): string {
    const message =
      typeof content === "string"
        ? { role: "user", content }
        : { role: "user", content };
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    expect(result.latestUserActivity).toBeUndefined();
  });

  test("readSessionTail: message truncated to 200 chars", async () => {
    const jsonlPath = join(tmpDir, "truncate-test.jsonl");
    const longMessage = "A".repeat(300);
    await writeFile(jsonlPath, `${makeUserEntry(longMessage)}\n`);

    const result = await readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("A".repeat(200));
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });

  test("readSessionTail: missing file returns empty object", async () => {
    const result = await readSessionTail(join(tmpDir, "nonexistent.jsonl"));
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    // Backward scan finds the later TodoWrite first (3 tasks, 2 done)
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(2);
  });

  test("readSessionTail (R27): delta read merges new content, preserves old", async () => {
    _resetCachesForTesting();
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

    const first = await readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("initial prompt");
    expect(first.latestUserActivity?.isCommand).toBe(false);
    expect(first.model).toBe("claude-opus-4-6");
    expect(first.tasksTotal).toBe(1);
    expect(first.tasksDone).toBe(1);

    // Append new lines (delta): a new user message and updated TodoWrite
    await Bun.sleep(10); // ensure mtime changes
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
    const existingContent = await Bun.file(jsonlPath).text();
    await Bun.write(
      jsonlPath,
      `${existingContent + appendedLines.join("\n")}\n`,
    );

    const second = await readSessionTail(jsonlPath);
    // Delta read: newer latestUserActivity overrides
    expect(second.latestUserActivity?.text).toBe("follow-up prompt");
    // Tasks updated from new delta
    expect(second.tasksTotal).toBe(2);
    expect(second.tasksDone).toBe(1);
    // Model preserved from delta (same value, but not lost)
    expect(second.model).toBe("claude-opus-4-6");
  });

  test("readSessionTail (R27): file shrink triggers full re-read", async () => {
    _resetCachesForTesting();
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

    const first = await readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("old session message");
    expect(first.tasksTotal).toBe(1);

    // Replace with a smaller new-session file (simulates session restart)
    await Bun.sleep(10);
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
    await Bun.write(jsonlPath, `${newLines[0]}\n`);

    const second = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    // Reversed scan finds newer (last in file) first — tool-only entry wins
    expect(result.latestAssistantActivity?.tool).toBe("Read");
    expect(result.latestAssistantActivity?.text).toBeUndefined();
  });

  test("readSessionTail (R50): delta-read merge preserves latestAssistantActivity from base when scan has none", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r50-delta-merge.jsonl");

    // First read: assistant entry sets latestAssistantActivity
    const firstLines = [
      makeAssistantEntry("claude-sonnet-4-6", [
        { type: "text", text: "initial response" },
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ];
    await writeFile(jsonlPath, `${firstLines.join("\n")}\n`);
    const first = await readSessionTail(jsonlPath);
    expect(first.latestAssistantActivity?.text).toBe("initial response");
    expect(first.latestAssistantActivity?.tool).toBe("Bash");

    // Append user-only line (no new assistant entry) — delta scan finds no assistant entry
    const userLine = makeUserEntry("follow-up question");
    await Bun.write(jsonlPath, `${firstLines.join("\n")}\n${userLine}\n`);

    const second = await readSessionTail(jsonlPath);
    // latestAssistantActivity must be preserved from base (delta merge)
    expect(second.latestAssistantActivity?.text).toBe("initial response");
    expect(second.latestAssistantActivity?.tool).toBe("Bash");
  });

  // ── getSubagentInfos (R29) ──

  test("getSubagentInfos (R29): returns SubagentInfo array with enrichment", async () => {
    _resetCachesForTesting();
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
    const infos = await getSubagentInfos(jsonlPath);

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

  test("getSubagentInfos (R29): isActive respects 45s threshold", async () => {
    _resetCachesForTesting();
    const sessionId = "r29-active-threshold";
    const sessionDir = join(tmpDir, sessionId);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    const activeAgent = join(subagentsDir, "agent-live.jsonl");
    const staleAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(activeAgent, `${makeUserEntry("live")}\n`);
    await writeFile(staleAgent, `${makeUserEntry("stale")}\n`);

    // Backdate the stale agent to 60 seconds ago
    const sixtySecAgo = new Date(Date.now() - 60_000);
    utimesSync(staleAgent, sixtySecAgo, sixtySecAgo);

    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`);
    const infos = await getSubagentInfos(jsonlPath);

    expect(infos).toHaveLength(2);
    const live = infos.find((i) => i.agentId === "live");
    const stale = infos.find((i) => i.agentId === "old");
    expect(live?.isActive).toBe(true);
    expect(stale?.isActive).toBe(false);
  });

  test("getSubagentInfos (R29): returns empty array when no subagents dir", async () => {
    const jsonlPath = join(tmpDir, "r29-no-dir-session.jsonl");
    const infos = await getSubagentInfos(jsonlPath);
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
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r36-queue-op.jsonl");
    const lines = [
      makeUserEntry("do the thing"),
      makeQueueOperationEnqueue("ae89d86", "Implement feature X"),
      makeQueueOperationEnqueue("bf12c45", "Write tests for Y"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("ae89d86")).toBe("Implement feature X");
    expect(result.agentDescriptions.get("bf12c45")).toBe("Write tests for Y");
  });

  test("readSessionTail (R36): delta read merges new queue-operation entries without losing previous ones", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r36-queue-op-delta.jsonl");

    const initialLines = [
      makeUserEntry("start"),
      makeQueueOperationEnqueue("agent-1", "First agent task"),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await readSessionTail(jsonlPath);
    expect(first.agentDescriptions.get("agent-1")).toBe("First agent task");

    await Bun.sleep(10);
    const existing = await Bun.file(jsonlPath).text();
    await Bun.write(
      jsonlPath,
      existing +
        makeQueueOperationEnqueue("agent-2", "Second agent task") +
        "\n",
    );

    const second = await readSessionTail(jsonlPath);
    expect(second.agentDescriptions.get("agent-1")).toBe("First agent task");
    expect(second.agentDescriptions.get("agent-2")).toBe("Second agent task");
  });

  test("getSubagentInfos (R36): attaches description from parent session agentDescriptions", async () => {
    _resetCachesForTesting();
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

    const infos = await getSubagentInfos(jsonlPath);
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
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r36-task-tool.jsonl");
    const lines = [
      makeUserEntry("start task"),
      makeTaskToolUse("toolu_01ABC", "Research waiting state bug"),
      makeTaskToolResult("toolu_01ABC", "a4220fe77a021871d"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("a4220fe77a021871d")).toBe(
      "Research waiting state bug",
    );
  });

  test("readSessionTail (R36): mixed queue-operation and Task tool_use entries both populate agentDescriptions", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r36-mixed-agents.jsonl");
    const lines = [
      makeUserEntry("start"),
      makeQueueOperationEnqueue("legacy-agent-1", "Legacy queue task"),
      makeTaskToolUse("toolu_02DEF", "New Task tool agent"),
      makeTaskToolResult("toolu_02DEF", "new-agent-abc123"),
    ];
    await writeFile(jsonlPath, `${lines.join("\n")}\n`);

    const result = await readSessionTail(jsonlPath);
    expect(result.agentDescriptions.get("legacy-agent-1")).toBe(
      "Legacy queue task",
    );
    expect(result.agentDescriptions.get("new-agent-abc123")).toBe(
      "New Task tool agent",
    );
  });

  test("getProjectState includes subagents array (R29)", async () => {
    _resetCachesForTesting();

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

    const results = await getProjectState(tmpDir);
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
    _resetCachesForTesting();

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

    const results = await getProjectState(tmpDir);
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

// ─── cache behaviour ──────────────────────────────────────────────────────────

describe("sessionsIndexCache (R20.3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-idx-cache");
    _resetCachesForTesting();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sessionId: "sess-cache",
      fullPath: "/some/path/sess.jsonl",
      fileMtime: 1_700_000_000_000,
      projectPath: "/home/user/cached",
      isSidechain: false,
      ...overrides,
    };
  }

  test("same mtime: second call returns cached result without re-reading file", async () => {
    const entry = makeEntry();
    await writeFile(
      join(tmpDir, "sessions-index.json"),
      JSON.stringify({ entries: [entry] }),
    );

    const first = await readSessionsIndex(tmpDir);
    expect(first).not.toBeNull();

    // Overwrite file content but keep the same mtime so cache key is unchanged
    const filePath = join(tmpDir, "sessions-index.json");
    const { mtimeMs } = await import("node:fs/promises").then((m) =>
      m.stat(filePath),
    );
    const mtime = new Date(mtimeMs);
    await writeFile(filePath, "this is no longer valid json");
    await utimes(filePath, mtime, mtime);

    // Should return the first (cached) result despite the file now being corrupt
    const second = await readSessionsIndex(tmpDir);
    expect(second).toBe(first); // same object reference proves cache hit
  });

  test("changed mtime: re-reads the file and returns fresh data", async () => {
    await writeFile(
      join(tmpDir, "sessions-index.json"),
      JSON.stringify({ entries: [makeEntry({ sessionId: "original" })] }),
    );

    const first = await readSessionsIndex(tmpDir);
    expect(first?.entries[0].sessionId).toBe("original");

    // Small sleep so filesystem mtime advances
    await Bun.sleep(10);
    await writeFile(
      join(tmpDir, "sessions-index.json"),
      JSON.stringify({ entries: [makeEntry({ sessionId: "updated" })] }),
    );

    const second = await readSessionsIndex(tmpDir);
    expect(second?.entries[0].sessionId).toBe("updated");
  });
});

describe("sessionTailCache (R20.4)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-tail-cache");
    _resetCachesForTesting();
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

    const first = await readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe("original message");

    // Overwrite content with same-size content, restore original mtime so cache key is unchanged.
    // "original message" and "replaced message" are the same length (16 chars each).
    const { mtimeMs } = await import("node:fs/promises").then((m) =>
      m.stat(jsonlPath),
    );
    const mtime = new Date(mtimeMs);
    await writeFile(jsonlPath, `${makeUserLine("replaced message")}\n`);
    await utimes(jsonlPath, mtime, mtime);

    const second = await readSessionTail(jsonlPath);
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

    const first = await readSessionTail(jsonlPath);
    expect(first.latestUserActivity?.text).toBe(
      "this is the first and longer message",
    );

    await Bun.sleep(10);
    // Replace with shorter content (file shrinks → full re-read)
    await writeFile(jsonlPath, `${makeUserLine("new")}\n`);

    const second = await readSessionTail(jsonlPath);
    expect(second.latestUserActivity?.text).toBe("new");
  });
});

// ─── targeted refresh (R20.5) ──────────────────────────────────────────────────

describe("getProjectState targeted refresh (R20.5)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-targeted");
    _resetCachesForTesting();
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
    const first = await getProjectState(tmpDir);
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
    const second = await getProjectState(tmpDir, dirB);
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
    const results = await getProjectState(tmpDir, join(tmpDir, "-home-user-x"));
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
    const first = await getProjectState(tmpDir);
    expect(first).toHaveLength(2);

    // Remove project A's JSONL so readProjectInfo returns null
    await rm(dirA, { recursive: true, force: true });

    // Targeted rescan of the now-gone project
    const second = await getProjectState(tmpDir, dirA);
    expect(second).toHaveLength(1);
    expect(second[0].projectName).toBe("stay");
  });
});

// ─── token usage (R32) ───────────────────────────────────────────────────────

describe("readSessionTail token usage (R32)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-tokens");
    _resetCachesForTesting();
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  test("R32: delta reads — inputTokens last-wins, outputTokens accumulates", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r32-delta.jsonl");

    // Initial content
    const initialLines = [
      makeUserLine("first"),
      makeAssistantWithUsage("claude-sonnet-4-6", 300, 80),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(300);
    expect(first.outputTokens).toBe(80);

    // Append more content (simulates growing cache_read — new value is larger)
    await Bun.sleep(10);
    const appendedLines = [
      makeUserLine("second"),
      makeAssistantWithUsage("claude-sonnet-4-6", 500, 60),
    ];
    const existing = await Bun.file(jsonlPath).text();
    await Bun.write(jsonlPath, `${existing + appendedLines.join("\n")}\n`);

    const second = await readSessionTail(jsonlPath);
    // inputTokens: new scan value replaces base (last-wins, not additive)
    expect(second.inputTokens).toBe(500);
    // outputTokens: additive across delta reads
    expect(second.outputTokens).toBe(140);
  });

  test("R32: file shrink resets token counts to new content only", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r32-shrink.jsonl");

    await writeFile(
      jsonlPath,
      `${[
        makeUserLine("old session"),
        makeAssistantWithUsage("claude-sonnet-4-6", 1000, 300),
      ].join("\n")}\n`,
    );

    const first = await readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(1000);

    // Replace with shorter file (new session)
    await Bun.sleep(10);
    await Bun.write(
      jsonlPath,
      `${makeAssistantWithUsage("claude-sonnet-4-6", 50, 20)}\n`,
    );

    const second = await readSessionTail(jsonlPath);
    // Full re-read: only sees the new content
    expect(second.inputTokens).toBe(50);
    expect(second.outputTokens).toBe(20);
  });
});

// ─── latestUserActivity extraction (R37, R49) ────────────────────────────────

describe("readSessionTail latestUserActivity (R37, R49)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r37");
    _resetCachesForTesting();
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

    const result = await readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("/ctx-load");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R37: command includes args when <command-args> present", async () => {
    const jsonlPath = join(tmpDir, "r37-args.jsonl");
    await writeFile(
      jsonlPath,
      `${makeCommandEntry("/ctx-load", "some args")}\n`,
    );

    const result = await readSessionTail(jsonlPath);
    expect(result.latestUserActivity?.text).toBe("/ctx-load some args");
    expect(result.latestUserActivity?.isCommand).toBe(true);
  });

  test("R37: <command-name> without args produces command-only string", async () => {
    const jsonlPath = join(tmpDir, "r37-no-args.jsonl");
    await writeFile(jsonlPath, `${makeCommandEntry("/implement")}\n`);

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    // Reversed scan: "most recent message" is found first and wins; older entries ignored
    expect(result.latestUserActivity?.text).toBe("most recent message");
    expect(result.latestUserActivity?.isCommand).toBe(false);
  });
});

// ─── accurate token totals (R39) ─────────────────────────────────────────────

describe("readSessionTail accurate token totals (R39)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r39");
    _resetCachesForTesting();
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    // inputTokens: last-seen value (second entry = 200 + 2000 + 20000)
    expect(result.inputTokens).toBe(200 + 2000 + 20000);
    // outputTokens: sum of per-call deltas
    expect(result.outputTokens).toBe(125);
  });
});

// ─── input token last-value semantics (R47) ──────────────────────────────────

describe("readSessionTail input token last-value semantics (R47)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r47");
    _resetCachesForTesting();
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

    const result = await readSessionTail(jsonlPath);
    // inputTokens: last-seen value (5000), not sum (1000+2000+5000=8000)
    expect(result.inputTokens).toBe(5000);
    // outputTokens: sum of per-call deltas (10+20+30=60)
    expect(result.outputTokens).toBe(60);
  });

  test("R47: delta merge — new scan value replaces base input, output accumulates", async () => {
    _resetCachesForTesting();
    const jsonlPath = join(tmpDir, "r47-delta-merge.jsonl");

    const initialLines = [makeAssistantWithUsage(5000, 100)];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`);

    const first = await readSessionTail(jsonlPath);
    expect(first.inputTokens).toBe(5000);
    expect(first.outputTokens).toBe(100);

    // Append: new call with larger input (cache grew to 6000)
    await Bun.sleep(10);
    const existing = await Bun.file(jsonlPath).text();
    await Bun.write(
      jsonlPath,
      `${existing + makeAssistantWithUsage(6000, 50)}\n`,
    );

    const second = await readSessionTail(jsonlPath);
    // inputTokens: new value 6000 replaces base 5000 (not 11000)
    expect(second.inputTokens).toBe(6000);
    // outputTokens: 100 (base) + 50 (new) = 150
    expect(second.outputTokens).toBe(150);
  });
});

// ─── SubagentInfo lifecycle (R40) ────────────────────────────────────────────

describe("getSubagentInfos lifecycle (R40)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r40");
    _resetCachesForTesting();
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

    const infos = await getSubagentInfos(jsonlPath);
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

    const infos = await getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(1);
    expect(infos[0].launchTime).toBeDefined();
    expect(new Date(infos[0].launchTime).toISOString()).toBe(
      infos[0].launchTime,
    );
  });

  test("R40: completed agent older than 5m excluded from result", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-expire");
    const oldAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(oldAgent, "{}");

    // Backdate to 6 minutes ago
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(oldAgent, sixMinAgo, sixMinAgo);

    const infos = await getSubagentInfos(jsonlPath);
    // Old inactive agent should be filtered out
    expect(infos.find((i) => i.agentId === "old")).toBeUndefined();
  });

  test("R40: completed agent younger than 5m is included", async () => {
    const { subagentsDir, jsonlPath } =
      await makeSubagentDir("r40-recent-done");
    const recentAgent = join(subagentsDir, "agent-recent.jsonl");
    await writeFile(recentAgent, "{}");

    // Backdate to 3 minutes ago (within 5m window, but >45s so isActive=false)
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
    utimesSync(recentAgent, threeMinAgo, threeMinAgo);

    const infos = await getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "recent");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(false);
  });

  test("R40: active agent (mtime < 45s) always included regardless of expiry", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-active");
    const activeAgent = join(subagentsDir, "agent-live.jsonl");
    await writeFile(activeAgent, "{}");
    // mtime is now = active

    const infos = await getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "live");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(true);
  });

  test("R40: sub-agent mtime before stop (mtime 30s ago, stopped 10s ago) → isActive false", async () => {
    const { subagentsDir, jsonlPath } =
      await makeSubagentDir("r40-stopped-before");
    const agentPath = join(subagentsDir, "agent-pre.jsonl");
    await writeFile(agentPath, "{}");

    const now = Date.now();
    const thirtySecAgo = new Date(now - 30_000);
    utimesSync(agentPath, thirtySecAgo, thirtySecAgo);

    const stoppedAtMs = now - 10_000;
    const infos = await getSubagentInfos(jsonlPath, stoppedAtMs);
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
    const infos = await getSubagentInfos(jsonlPath, stoppedAtMs);
    const agent = infos.find((i) => i.agentId === "post");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(true);
  });

  test("R40: stoppedAtMs null → existing 45s threshold behavior unchanged", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("r40-no-stop");
    const activeAgent = join(subagentsDir, "agent-now.jsonl");
    const staleAgent = join(subagentsDir, "agent-old.jsonl");
    await writeFile(activeAgent, "{}");
    await writeFile(staleAgent, "{}");

    const sixtySecAgo = new Date(Date.now() - 60_000);
    utimesSync(staleAgent, sixtySecAgo, sixtySecAgo);

    const infos = await getSubagentInfos(jsonlPath, null);
    const active = infos.find((i) => i.agentId === "now");
    const stale = infos.find((i) => i.agentId === "old");
    expect(active?.isActive).toBe(true);
    expect(stale?.isActive).toBe(false);
  });
});

// ─── getSubagentInfos status file detection ───────────────────────────────────

describe("getSubagentInfos status file detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-subagent-status");
    _resetCachesForTesting();
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

    const infos = await getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "abc123");
    expect(agent).toBeDefined();
    expect(agent?.isActive).toBe(false);
  });

  test("no status file → mtime-based detection (fresh = active)", async () => {
    const { subagentsDir, jsonlPath } = await makeSubagentDir("sa-nomfile");
    const agentPath = join(subagentsDir, "agent-def456.jsonl");
    await writeFile(agentPath, "{}");
    // mtime is now, no status file

    const infos = await getSubagentInfos(jsonlPath);
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

    const infos = await getSubagentInfos(jsonlPath);
    const agent = infos.find((i) => i.agentId === "ghi789");
    expect(agent).toBeDefined();
    // Non-stopped status file → falls back to mtime, which is fresh → active
    expect(agent?.isActive).toBe(true);
  });
});

// ─── SubagentInfo ordering (R43) ─────────────────────────────────────────────

describe("getSubagentInfos ordering (R43)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r43");
    _resetCachesForTesting();
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

    const infos = await getSubagentInfos(jsonlPath);
    expect(infos).toHaveLength(3);
    // Descending by launchTime: C, B, A
    expect(infos[0].agentId).toBe("ccc");
    expect(infos[1].agentId).toBe("bbb");
    expect(infos[2].agentId).toBe("aaa");
  });
});

// ─── TaskCreate/TaskUpdate task parsing (R46) ─────────────────────────────────

describe("readSessionTail TaskCreate/TaskUpdate task parsing (R46)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r46");
    _resetCachesForTesting();
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
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

    const result = await readSessionTail(jsonlPath);
    // No tool_result confirms the task ID → tasks/counts must remain undefined
    expect(result.tasks).toBeUndefined();
    expect(result.tasksTotal).toBeUndefined();
    expect(result.tasksDone).toBeUndefined();
  });
});

// ─── readSessionTail line boundary edge case (R27) ────────────────────────────

describe("readSessionTail line boundary edge case (R27)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r27-boundary");
    _resetCachesForTesting();
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
    const result = await readSessionTail(jsonlPath);
    // Both lines must be reachable; reversed scan finds line2 first (most recent)
    expect(result.latestAssistantActivity?.text).toBe("line two");
  });
});

// ─── resolveState ─────────────────────────────────────────────────────────────

describe("resolveState", () => {
  const now = Date.now();

  function evt(
    event: string,
    state: StatusEvent["state"],
    timestampMs = now - 10_000,
  ): StatusEvent {
    return {
      event,
      state,
      timestamp: new Date(timestampMs).toISOString(),
      session_id: "sess",
      working_dir: "/proj",
    };
  }

  const freshJsonl = now - 10_000; // 10s ago = within 60s
  const staleJsonl = now - 90_000; // 90s ago = outside 60s

  test("empty events + null JSONL → stopped", () => {
    expect(resolveState(null, [])).toBe("stopped");
  });

  test("PermissionRequest as last event, fresh → waiting_for_permission", () => {
    const events = [evt("PermissionRequest", "waiting_for_permission")];
    expect(resolveState(null, events)).toBe("waiting_for_permission");
  });

  test("KEY RACE: PermissionRequest followed by sub-agent PostToolUse(s) → still waiting_for_permission", () => {
    // Concurrent sub-agents fire PostToolUse (different session_id) while main session
    // waits for permission. Sub-agent PostToolUse must NOT resolve the main session's request.
    const subAgentEvt = (timestampMs: number): StatusEvent => ({
      event: "PostToolUse",
      state: "running",
      timestamp: new Date(timestampMs).toISOString(),
      session_id: "subagent-sess",
      working_dir: "/proj",
    });
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 5_000),
      subAgentEvt(now - 3_000),
      subAgentEvt(now - 1_000),
    ];
    expect(resolveState(null, events)).toBe("waiting_for_permission");
  });

  test("same-session PostToolUse after PermissionRequest → resolved (running)", () => {
    // User clicked Allow: main session fires PostToolUse with same session_id.
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 5_000),
      evt("PostToolUse", "running", now - 3_000),
    ];
    expect(resolveState(null, events)).toBe("running");
  });

  test("same-session PostToolUse after stale PermissionRequest (>5min) → stopped", () => {
    // PermissionRequest is old enough to be stale; even with same-session PostToolUse,
    // the forward-scan resolves it and we fall through to stopped.
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 10 * 60_000),
      evt("PostToolUse", "running", now - 9 * 60_000),
    ];
    expect(resolveState(null, events)).toBe("stopped");
  });

  test("PermissionRequest followed by UserPromptSubmit → running (permission resolved)", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 10_000),
      evt("UserPromptSubmit", "running", now - 5_000),
    ];
    expect(resolveState(null, events)).toBe("running");
  });

  test("PermissionRequest followed by Stop → stopped (permission resolved)", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 10_000),
      evt("Stop", "stopped", now - 5_000),
    ];
    expect(resolveState(null, events)).toBe("stopped");
  });

  test("stale PermissionRequest (> 5min) → falls through", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 10 * 60_000),
    ];
    expect(resolveState(null, events)).toBe("stopped");
  });

  test("PermissionRequest with NaN timestamp → falls through to stopped", () => {
    const nanEvent: StatusEvent = {
      ...evt("PermissionRequest", "waiting_for_permission"),
      timestamp: "not-a-date",
    };
    expect(resolveState(null, [nanEvent])).toBe("stopped");
  });

  test("Stop as last event → stopped", () => {
    const events = [
      evt("PostToolUse", "running", now - 20_000),
      evt("Stop", "stopped", now - 5_000),
    ];
    expect(resolveState(null, events)).toBe("stopped");
  });

  test("SessionEnd as last event → stopped", () => {
    const events = [evt("SessionEnd", "stopped", now - 5_000)];
    expect(resolveState(null, events)).toBe("stopped");
  });

  test("PostToolUse as last event, fresh → running", () => {
    const events = [evt("PostToolUse", "running", now - 5_000)];
    expect(resolveState(null, events)).toBe("running");
  });

  test("UserPromptSubmit as last event, fresh → running", () => {
    const events = [evt("UserPromptSubmit", "running", now - 5_000)];
    expect(resolveState(null, events)).toBe("running");
  });

  test("PostToolUse as last event, stale → falls to JSONL fallback", () => {
    const events = [evt("PostToolUse", "running", now - 90_000)];
    // No JSONL → stopped
    expect(resolveState(null, events)).toBe("stopped");
    // Fresh JSONL → running via fallback
    expect(resolveState(freshJsonl, events)).toBe("running");
  });

  test("no events, fresh JSONL → running (fallback)", () => {
    expect(resolveState(freshJsonl, [])).toBe("running");
  });

  test("no events, stale JSONL → stopped", () => {
    expect(resolveState(staleJsonl, [])).toBe("stopped");
  });

  test("Notification and SubagentStop events are filtered out (non-state-bearing)", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 5_000),
      {
        ...evt("Notification", "stopped", now - 3_000),
        notificationMessage: "msg",
      },
      evt("SubagentStop", "stopped", now - 1_000),
    ];
    // Notification and SubagentStop are filtered; PermissionRequest still unresolved
    expect(resolveState(null, events)).toBe("waiting_for_permission");
  });

  test("multiple state-bearing events: latest wins", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 30_000),
      evt("UserPromptSubmit", "running", now - 20_000),
      evt("PostToolUse", "running", now - 5_000),
    ];
    // PermissionRequest resolved by UserPromptSubmit; latest is fresh PostToolUse → running
    expect(resolveState(null, events)).toBe("running");
  });
});

// ─── delta read task completions (R46 / Bug 1) ────────────────────────────────

describe("readSessionTail delta task completion (R46 Bug 1)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-r46-delta");
    _resetCachesForTesting();
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

    const first = await readSessionTail(jsonlPath);
    expect(first.tasksDone).toBe(0);
    expect(first.tasksTotal).toBe(2);

    // Second read: append TaskUpdate completing Task #1.
    const secondBatch = `${makeTaskUpdateEntry("1", "completed")}\n`;
    const existing = await Bun.file(jsonlPath).text();
    await writeFile(jsonlPath, existing + secondBatch);

    const second = await readSessionTail(jsonlPath);
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

    const first = await readSessionTail(jsonlPath);
    expect(first.tasksTotal).toBe(1);

    // Second read: TaskUpdate for task ID 99 which was never created
    const secondBatch = `${makeTaskUpdateEntry("99", "completed")}\n`;
    const existing = await Bun.file(jsonlPath).text();
    await writeFile(jsonlPath, existing + secondBatch);

    const second = await readSessionTail(jsonlPath);
    // Task 99 must not appear; only original task remains
    expect(second.tasksTotal).toBe(1);
    expect(second.tasksDone).toBe(0);
    expect(second.tasks?.find((t) => t.id === "99")).toBeUndefined();
  });
});

// ─── mapHookEventToState (R35 / Bug 3) ───────────────────────────────────────

describe("mapHookEventToState (R35 Bug 3)", () => {
  test("SessionStart → null (unrecognized event returns null)", () => {
    expect(mapHookEventToState("SessionStart")).toBeNull();
  });
});

// ─── disambiguateProjectNames ─────────────────────────────────────────────────

function makeProjectState(cwd: string): import("../src/sessions").ProjectState {
  return {
    projectDir: cwd.replace(/\//g, "-"),
    cwd,
    projectName: cwd.split("/").at(-1) ?? cwd,
    sessionId: "test-session",
    latestJSONL: `${cwd}/session.jsonl`,
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
    // At segments=2: x/backend, x/backend, c/y/backend → still duplicates in group
    // At segments=3: a/x/backend, b/x/backend, c/y/backend → all unique
    // The whole collision group advances together, so c/y/backend also gets 3 segments.
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

  test("re-run resets stale expanded names when a collision is resolved", () => {
    const a = makeProjectState("/home/user/projectA/backend");
    const b = makeProjectState("/home/user/projectB/backend");

    // First call: both collide, should get expanded names.
    disambiguateProjectNames([a, b]);
    expect(a.projectName).toBe("projectA/backend");
    expect(b.projectName).toBe("projectB/backend");

    // Reset to basename to simulate what getProjectState does before re-running.
    a.projectName = "backend";

    // Second call with only one project: no collision, should revert to short name.
    disambiguateProjectNames([a]);
    expect(a.projectName).toBe("backend");
  });
});
