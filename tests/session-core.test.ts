import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatusEvent } from "../src/session-core.ts";
import {
  PERMISSION_RESOLVE_GAP_MS,
  parseStatusLines,
  readStatusLog,
  resolveState,
  STATUS_FILE_LEGACY,
  STATUS_LOG_FILE,
} from "../src/session-core.ts";
import { makeTempDir } from "./_helpers.ts";

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

  test("keeps the first complete record when a bounded tail starts on a newline", () => {
    const first = makeEvent("PostToolUse", "running");
    const second = makeEvent("Stop", "stopped");

    expect(
      parseStatusLines(
        `\n${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
        true,
      ),
    ).toEqual([first, second]);
  });

  test("drops a genuinely partial first record from a bounded tail", () => {
    const complete = makeEvent("Stop", "stopped");

    expect(
      parseStatusLines(`partial${JSON.stringify(complete)}\n`, true),
    ).toEqual([]);
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
    // In practice all hook events share the same session_id; the time-gap check handles this.
    // Here sub-agents use a different session_id to also verify the session_id guard.
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

  test("same-session PostToolUse within PERMISSION_RESOLVE_GAP_MS does NOT resolve PermissionRequest", () => {
    const permTs = now - 10_000;
    const events = [
      evt("PermissionRequest", "waiting_for_permission", permTs),
      evt("PostToolUse", "running", permTs + 1_000),
    ];
    expect(resolveState(null, events)).toBe("waiting_for_permission");
  });

  test("same-session PostToolUse after PERMISSION_RESOLVE_GAP_MS resolves PermissionRequest", () => {
    const permTs = now - 10_000;
    const events = [
      evt("PermissionRequest", "waiting_for_permission", permTs),
      evt("PostToolUse", "running", permTs + PERMISSION_RESOLVE_GAP_MS + 1_000),
    ];
    expect(resolveState(null, events)).toBe("running");
  });

  test("within-gap PostToolUse skipped, after-gap PostToolUse resolves", () => {
    const permTs = now - 10_000;
    const events = [
      evt("PermissionRequest", "waiting_for_permission", permTs),
      evt("PostToolUse", "running", permTs + 1_000),
      evt("PostToolUse", "running", permTs + PERMISSION_RESOLVE_GAP_MS + 1_000),
    ];
    expect(resolveState(null, events)).toBe("running");
  });

  test("same-session PostToolUse after PermissionRequest → resolved (running)", () => {
    // User clicked Allow: main session fires PostToolUse with same session_id.
    const permTs = now - 10_000;
    const events = [
      evt("PermissionRequest", "waiting_for_permission", permTs),
      evt("PostToolUse", "running", permTs + 5_000),
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

  test("SessionEnd as last event → closed", () => {
    const events = [evt("SessionEnd", "closed", now - 5_000)];
    expect(resolveState(null, events)).toBe("closed");
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

  test("StopFailure as last event → error", () => {
    const events = [
      evt("PostToolUse", "running", now - 20_000),
      evt("StopFailure", "error", now - 10_000),
    ];
    expect(resolveState(null, events)).toBe("error");
  });

  test("StopFailure then JSONL activity → running", () => {
    const events = [evt("StopFailure", "error", now - 90_000)];
    expect(resolveState(freshJsonl, events)).toBe("running");
  });

  test("PermissionRequest then StopFailure → error (not waiting)", () => {
    const events = [
      evt("PermissionRequest", "waiting_for_permission", now - 10_000),
      evt("StopFailure", "error", now - 5_000),
    ];
    expect(resolveState(null, events)).toBe("error");
  });

  test("recent StopFailure with recent JSONL → error (not running)", () => {
    const events = [
      {
        event: "StopFailure",
        state: "error",
        timestamp: new Date(now - 10_000).toISOString(),
        session_id: "s1",
        working_dir: "/tmp",
      },
    ];
    const jsonlMtime = now - 5_000;
    const state = resolveState(jsonlMtime, events as StatusEvent[]);
    expect(state).toBe("error");
  });
});
