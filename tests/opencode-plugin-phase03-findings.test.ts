import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { findingsSink, appendFileMock, mkdirMock } = vi.hoisted(() => ({
  findingsSink: {
    active: false,
    stateHome: null as string | null,
    statusLogs: new Map<string, string>(),
    nativeAppendFile: null as
      | ((path: string, data: string) => Promise<void>)
      | null,
    nativeMkdir: null as
      | ((
          path: string,
          options?: { recursive?: boolean },
        ) => Promise<string | undefined>)
      | null,
  },
  appendFileMock: vi.fn(),
  mkdirMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  findingsSink.nativeAppendFile = (path, data) => actual.appendFile(path, data);
  findingsSink.nativeMkdir = (path, options) => actual.mkdir(path, options);
  appendFileMock.mockImplementation(appendToSink);
  mkdirMock.mockImplementation(handleMkdir);
  return { ...actual, appendFile: appendFileMock, mkdir: mkdirMock };
});

import { ccmonPlugin } from "../resources/opencode-plugin/ccmon.ts";

const previousStateHome = process.env.XDG_STATE_HOME;

type StatusRecord = {
  event: string;
  session_id: string;
  state: string;
};

function isFindingsPath(path: string): boolean {
  return (
    findingsSink.active &&
    findingsSink.stateHome !== null &&
    path.startsWith(`${findingsSink.stateHome}/`)
  );
}

async function appendToSink(path: string, data: string): Promise<void> {
  if (isFindingsPath(path)) {
    findingsSink.statusLogs.set(
      path,
      `${findingsSink.statusLogs.get(path) ?? ""}${data}`,
    );
    return;
  }
  if (!findingsSink.nativeAppendFile) {
    throw new Error("native appendFile fallback is not initialized");
  }
  await findingsSink.nativeAppendFile(path, data);
}

async function handleMkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  if (isFindingsPath(path)) return;
  if (!findingsSink.nativeMkdir) {
    throw new Error("native mkdir fallback is not initialized");
  }
  await findingsSink.nativeMkdir(path, options);
}

function resetFindingsSink(): void {
  findingsSink.active = false;
  findingsSink.stateHome = null;
  findingsSink.statusLogs.clear();
  appendFileMock.mockImplementation(appendToSink);
  mkdirMock.mockImplementation(handleMkdir);
  appendFileMock.mockClear();
  mkdirMock.mockClear();
}

describe("ccmon OpenCode plugin Phase 03 finding regressions", () => {
  const activePlugins = new Set<{ dispose: () => Promise<void> }>();
  let nextStateHome = 0;

  afterEach(() => {
    return cleanup();
  });

  async function createPlugin(
    logs: Array<{ level: string; message: string }> = [],
  ) {
    const stateHome = `/virtual/ccmon-plugin-findings-${nextStateHome}`;
    nextStateHome += 1;
    findingsSink.active = true;
    findingsSink.stateHome = stateHome;
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
    activePlugins.add(plugin);
    return {
      plugin,
      statusPath: join(stateHome, "ccmon", "opencode-status.jsonl"),
    };
  }

  function records(statusPath: string): StatusRecord[] {
    return (findingsSink.statusLogs.get(statusPath) ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusRecord);
  }

  async function cleanup(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    for (const plugin of activePlugins) {
      try {
        await plugin.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      activePlugins.clear();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      resetFindingsSink();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      vi.useRealTimers();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "failed to clean up OpenCode findings test state",
      );
    }
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
    appendFileMock.mockImplementation(async (path: string, data: string) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        firstWriteStarted();
        await writeGate;
      }
      await appendToSink(path, data);
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
    await vi.advanceTimersByTimeAsync(15_000);

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
    appendFileMock.mockImplementation(async (path: string, data: string) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        firstWriteStarted();
        await writeGate;
      }
      await appendToSink(path, data);
    });

    const { plugin, statusPath } = await createPlugin(logs);
    const seed = plugin["chat.message"]({ sessionID: "write-seed" });
    await firstWrite;
    const activeCount = 260;
    const pressuredSession = `heartbeat-${activeCount - 1}`;
    const starts = Array.from({ length: activeCount }, (_, index) =>
      plugin["tool.execute.before"]({
        sessionID: `heartbeat-${index}`,
        input: { callID: `call-${index}` },
      }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
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
    expect(
      records(statusPath).filter(
        (record) => record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(256);
    expect(
      logs.filter((entry) =>
        entry.message.includes("heartbeat write queue is full"),
      ),
    ).toHaveLength(4);
    await plugin.dispose();
  });
});
