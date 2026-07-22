import { mkdtempSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: vi.fn(actual.appendFile),
  };
});

import {
  ccmonPlugin,
  MAX_PENDING_WRITES,
} from "../resources/opencode-plugin/ccmon.ts";

const appendFileMock = vi.mocked(appendFile);
const defaultAppendFile = appendFileMock.getMockImplementation();
const previousStateHome = process.env.XDG_STATE_HOME;

type StatusRecord = {
  event: string;
  session_id: string;
  state: string;
};

describe("ccmon OpenCode plugin Phase 03 finding regressions", () => {
  afterEach(() => {
    if (defaultAppendFile) appendFileMock.mockImplementation(defaultAppendFile);
    vi.useRealTimers();
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  });

  async function createPlugin(
    logs: Array<{ level: string; message: string }> = [],
  ) {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-findings-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: (entry) => logs.push(entry) },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });
    return {
      plugin,
      statusPath: join(stateHome, "ccmon", "opencode-status.jsonl"),
    };
  }

  function records(statusPath: string): StatusRecord[] {
    return readFileSync(statusPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusRecord);
  }

  async function waitForRecord(
    statusPath: string,
    predicate: (record: StatusRecord) => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (records(statusPath).some(predicate)) return;
      } catch {
        // The first queued write may not have created the file yet.
      }
      await delay(5);
    }
    throw new Error("expected matching status record");
  }

  test.each([
    "session.idle",
    "permission.asked",
  ])("skips a queued ordinary running record after newer %s evidence", async (evidenceType) => {
    const logs: Array<{ level: string; message: string }> = [];
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let appendCalls = 0;
    appendFileMock.mockImplementation(async (...args) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        firstWriteStarted();
        await writeGate;
      }
      return defaultAppendFile?.(...args) ?? Promise.resolve();
    });

    const { plugin, statusPath } = await createPlugin(logs);
    const seed = plugin["chat.message"]({ sessionID: "write-seed" });
    await firstWrite;
    const running = plugin["tool.execute.before"]({
      sessionID: "stale-running",
      input: { callID: "stale-call" },
    });

    const newerEvidence =
      evidenceType === "session.idle"
        ? plugin.event({
            event: {
              type: evidenceType,
              properties: { sessionID: "stale-running" },
            },
          })
        : plugin.event({
            event: {
              type: evidenceType,
              properties: {
                sessionID: "stale-running",
                permissionID: "fresh-permission",
              },
            },
          });

    releaseFirstWrite();
    await Promise.all([running, newerEvidence]);

    expect(records(statusPath).map((record) => record.event)).toEqual([
      "chat.message",
      evidenceType,
    ]);
    expect(records(statusPath).map((record) => record.session_id)).toEqual([
      "write-seed",
      "stale-running",
    ]);
    await seed;
    if (evidenceType === "permission.asked") {
      expect(records(statusPath)[1]).toMatchObject({
        state: "waiting_for_permission",
      });
    }
    expect(logs).toEqual([]);
    await plugin.dispose();
  });

  test("preserves blockers under session pressure and resumes after all matching resolutions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();
    const pressuredSession = "pressured-79";

    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        plugin["tool.execute.before"]({
          sessionID: `pressured-${index}`,
          input: { callID: `call-${index}` },
        }),
      ),
    );
    expect(vi.getTimerCount()).toBe(80);

    await plugin.event({
      event: {
        type: "permission.asked",
        properties: {
          sessionID: pressuredSession,
          permissionID: "permission-a",
        },
      },
    });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: {
          sessionID: pressuredSession,
          requestID: "question-a",
        },
      },
    });
    await plugin["tool.execute.before"]({
      sessionID: pressuredSession,
      input: { callID: "ordinary-under-blocker" },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    let pressuredRecords = records(statusPath).filter(
      (record) => record.session_id === pressuredSession,
    );
    expect(pressuredRecords.map((record) => record.event)).toEqual([
      "tool.execute.before",
      "permission.asked",
      "question.asked",
    ]);

    await plugin.event({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: pressuredSession,
          permissionID: "permission-a",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    pressuredRecords = records(statusPath).filter(
      (record) => record.session_id === pressuredSession,
    );
    expect(
      pressuredRecords.filter(
        (record) => record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(0);

    await plugin.event({
      event: {
        type: "question.rejected",
        properties: {
          sessionID: pressuredSession,
          requestID: "question-a",
        },
      },
    });
    expect(vi.getTimerCount()).toBe(80);
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForRecord(
      statusPath,
      (record) =>
        record.session_id === pressuredSession &&
        record.event === "tool.execute.heartbeat",
    );

    pressuredRecords = records(statusPath).filter(
      (record) => record.session_id === pressuredSession,
    );
    expect(pressuredRecords.map((record) => record.event)).toEqual([
      "tool.execute.before",
      "permission.asked",
      "question.asked",
      "permission.replied",
      "question.rejected",
      "tool.execute.heartbeat",
    ]);
    expect(
      pressuredRecords.filter(
        (record) => record.event === "tool.execute.before",
      ),
    ).toHaveLength(1);

    await plugin.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("caps pending heartbeats without dropping a fresh blocker", async () => {
    vi.useFakeTimers();
    const logs: Array<{ level: string; message: string }> = [];
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let appendCalls = 0;
    appendFileMock.mockImplementation(async (...args) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        firstWriteStarted();
        await writeGate;
      }
      return defaultAppendFile?.(...args) ?? Promise.resolve();
    });

    const { plugin, statusPath } = await createPlugin(logs);
    const seed = plugin["chat.message"]({ sessionID: "write-seed" });
    await firstWrite;
    const activeCount = MAX_PENDING_WRITES + 4;
    const pressuredSession = `heartbeat-${activeCount - 1}`;
    const starts = Array.from({ length: activeCount }, (_, index) =>
      plugin["tool.execute.before"]({
        sessionID: `heartbeat-${index}`,
        input: { callID: `call-${index}` },
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const blocker = plugin.event({
      event: {
        type: "permission.asked",
        properties: {
          sessionID: pressuredSession,
          permissionID: "fresh-under-pressure",
        },
      },
    });
    const ordinaryRunning = plugin["tool.execute.before"]({
      sessionID: pressuredSession,
      input: { callID: "ordinary-under-pressure" },
    });

    releaseFirstWrite();
    await Promise.all([seed, ...starts, blocker, ordinaryRunning]);

    const pressuredRecords = records(statusPath).filter(
      (record) => record.session_id === pressuredSession,
    );
    expect(pressuredRecords.map((record) => record.event)).toContain(
      "permission.asked",
    );
    expect(
      pressuredRecords.filter(
        (record) => record.event === "tool.execute.before",
      ),
    ).toHaveLength(0);
    expect(
      logs.some((entry) =>
        entry.message.includes("heartbeat write queue is full"),
      ),
    ).toBe(true);
    await plugin.dispose();
  });
});
