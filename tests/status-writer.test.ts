import { appendFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MAX_STATUS_LOG_BYTES } from "../src/project-utils.ts";
import type { StatusEvent } from "../src/session-core.ts";
import { readStatusLog, STATUS_LOG_FILE } from "../src/session-core.ts";
import {
  mapHookEventToState,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
} from "../src/status-writer.ts";
import { makeTempDir } from "./_helpers.ts";

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

  test("StopFailure → error", () => {
    expect(mapHookEventToState("StopFailure")).toBe("error");
  });

  test("SessionEnd → closed", () => {
    expect(mapHookEventToState("SessionEnd")).toBe("closed");
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
    // Write enough data to exceed trim threshold (MAX_STATUS_LOG_BYTES + STATUS_LOG_TAIL_BYTES)
    const bigLine = JSON.stringify(makeEvent("PostToolUse", "running"));
    const linesNeeded =
      Math.ceil((MAX_STATUS_LOG_BYTES + 8192) / (bigLine.length + 1)) + 10;
    let bulk = "";
    for (let i = 0; i < linesNeeded; i++) {
      bulk += `${bigLine}\n`;
    }
    await writeFile(logPath, bulk);

    // One more append triggers the trim
    await writeStatusEvent(tmpDir, makeEvent("Stop", "stopped"));

    const s = await stat(logPath);
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

  test("R26.3: permission_prompt writes synthetic PermissionRequest when state is not waiting_for_permission", async () => {
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
    expect(events[1].event).toBe("PermissionRequest");
    expect(events[1].state).toBe("waiting_for_permission");
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

  test("permission_prompt writes synthetic PermissionRequest when not waiting", async () => {
    const existing: StatusEvent = {
      event: "PostToolUse",
      state: "running",
      timestamp: new Date().toISOString(),
      session_id: "sess-5",
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
      "sess-5",
      "/home/user/proj",
    );

    const events = await readStatusLog(tmpDir);
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe("PermissionRequest");
    expect(events[1].state).toBe("waiting_for_permission");
    expect(events[1].session_id).toBe("sess-5");
    expect(events[1].working_dir).toBe("/home/user/proj");
  });
});

// ─── mapHookEventToState (R35 / Bug 3) ───────────────────────────────────────

describe("mapHookEventToState (R35 Bug 3)", () => {
  test("SessionStart → null (unrecognized event returns null)", () => {
    expect(mapHookEventToState("SessionStart")).toBeNull();
  });
});
