import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as pluginModule from "../resources/opencode-plugin/ccmon.ts";
import { ccmonPlugin } from "../resources/opencode-plugin/ccmon.ts";

const { heartbeatSink, appendFileMock, mkdirMock } = vi.hoisted(() => ({
  heartbeatSink: {
    active: false,
    stateHome: null as string | null,
    statusLogs: new Map<string, string>(),
  },
  appendFileMock: vi.fn(),
  mkdirMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  appendFileMock.mockImplementation(async (path: string, data: string) => {
    if (isHeartbeatPath(path)) {
      heartbeatSink.statusLogs.set(
        path,
        `${heartbeatSink.statusLogs.get(path) ?? ""}${data}`,
      );
      return;
    }
    await actual.appendFile(path, data);
  });
  mkdirMock.mockImplementation(
    async (path: string, options?: { recursive?: boolean }) => {
      if (isHeartbeatPath(path)) return;
      await actual.mkdir(path, options);
    },
  );
  return {
    ...actual,
    appendFile: appendFileMock,
    mkdir: mkdirMock,
  };
});

function isHeartbeatPath(path: string): boolean {
  return (
    heartbeatSink.active &&
    heartbeatSink.stateHome !== null &&
    path.startsWith(`${heartbeatSink.stateHome}/`)
  );
}

function resetHeartbeatSink(): void {
  heartbeatSink.active = false;
  heartbeatSink.stateHome = null;
  heartbeatSink.statusLogs.clear();
  appendFileMock.mockClear();
  mkdirMock.mockClear();
}

describe("ccmon OpenCode plugin module contract", () => {
  test("exports only callable plugin factories", () => {
    expect(Object.keys(pluginModule)).toEqual(["ccmonPlugin"]);
    expect(
      Object.values(pluginModule).every((entry) => typeof entry === "function"),
    ).toBe(true);
  });
});

describe("ccmon OpenCode plugin blocker lifecycle records", () => {
  const previousStateHome = process.env.XDG_STATE_HOME;

  afterEach(() => {
    try {
      resetHeartbeatSink();
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    }
  });

  test("force-writes request-aware ask, reply, and rejection records", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_1", id: "question-1" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_1", id: "permission-1" },
      },
    });
    await plugin.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses_1", requestID: "question-1" },
      },
    });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_1", id: "question-2" },
      },
    });
    await plugin.event({
      event: {
        type: "question.rejected",
        properties: { sessionID: "ses_1", requestID: "question-2" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_1", permissionId: "permission-1" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_1", id: "permission-2" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.rejected",
        properties: { sessionID: "ses_1", permissionID: "permission-2" },
      },
    });
    await plugin.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses_1", id: "message-not-a-request" },
      },
    });

    const lines = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toMatchObject([
      {
        event: "question.asked",
        state: "waiting_for_permission",
        request_id: "question-1",
        blocker_kind: "question",
      },
      {
        event: "permission.asked",
        state: "waiting_for_permission",
        request_id: "permission-1",
        blocker_kind: "permission",
      },
      {
        event: "question.replied",
        state: "running",
        request_id: "question-1",
        blocker_kind: "question",
      },
      {
        event: "question.asked",
        state: "waiting_for_permission",
        request_id: "question-2",
        blocker_kind: "question",
      },
      {
        event: "question.rejected",
        state: "running",
        request_id: "question-2",
        blocker_kind: "question",
      },
      {
        event: "permission.replied",
        state: "running",
        request_id: "permission-1",
        blocker_kind: "permission",
      },
      {
        event: "permission.asked",
        state: "waiting_for_permission",
        request_id: "permission-2",
        blocker_kind: "permission",
      },
      {
        event: "permission.rejected",
        state: "running",
        request_id: "permission-2",
        blocker_kind: "permission",
      },
      {
        event: "question.replied",
        state: "running",
        blocker_kind: "question",
      },
    ]);
    expect(lines[8].request_id).toBeUndefined();
  });

  test("serializes concurrent lifecycle writes and suppresses late running evidence", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await Promise.all([
      plugin.event({
        event: {
          type: "permission.asked",
          properties: { sessionID: "ses_2", permissionId: "permission-2" },
        },
      }),
      plugin.event({
        event: {
          type: "permission.replied",
          properties: { sessionID: "ses_2", permissionID: "permission-2" },
        },
      }),
    ]);
    await Promise.all([
      plugin.event({
        event: { type: "session.error", properties: { sessionID: "ses_2" } },
      }),
      plugin["tool.execute.after"]({ sessionID: "ses_2" }),
    ]);
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_2", requestID: "late" },
      },
    });
    await plugin.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses_2", requestID: "late" },
      },
    });
    await plugin.event({
      event: {
        type: "question.rejected",
        properties: { sessionID: "ses_2", requestID: "late" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_2", permissionID: "late-permission" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_2", permissionID: "late-permission" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.rejected",
        properties: { sessionID: "ses_2", permissionID: "late-permission" },
      },
    });

    const lines = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines.map((line) => line.event)).toEqual([
      "permission.asked",
      "permission.replied",
      "session.error",
    ]);
  });

  test("serializes empty lifecycle IDs as the shared legacy representation", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_3", permissionID: "" },
      },
    });
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_3", permissionId: "" },
      },
    });

    const lines = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines.map((line) => line.event)).toEqual([
      "permission.asked",
      "permission.replied",
    ]);
    expect(lines.every((line) => line.request_id === undefined)).toBe(true);
  });

  test("uses chat, UserPromptSubmit, and session.created as soft-idle generation transitions", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_4" } },
    });
    await plugin["tool.execute.after"]({ sessionID: "ses_4" });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_4", requestID: "late" },
      },
    });
    await plugin["chat.message"]({ sessionID: "ses_4" });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_4", directory: "/home/user/project" } },
      },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_4", permissionID: "fresh" },
      },
    });

    const events = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);

    expect(events).toEqual([
      "session.idle",
      "chat.message",
      "session.created",
      "permission.asked",
    ]);
  });

  test("persists a reused child session.created generation before its blocker", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "child" } },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: "parent" } },
      },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "child", permissionID: "fresh" },
      },
    });

    const records = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.map((record) => [record.session_id, record.event])).toEqual([
      ["child", "session.idle"],
      ["child", "session.created"],
      ["parent", "subagent.created"],
      ["child", "permission.asked"],
    ]);
  });

  test("writes session.created before delayed metadata and concurrent blockers", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    let resolveSessionLookup: (() => void) | undefined;
    const sessionLookup = new Promise<void>((resolve) => {
      resolveSessionLookup = resolve;
    });
    const plugin = await ccmonPlugin({
      client: {
        session: {
          get: async () => {
            await sessionLookup;
            return { id: "ses_5", directory: "/home/user/project" };
          },
        },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    const created = plugin.event({
      event: { type: "session.created", properties: { info: { id: "ses_5" } } },
    });
    const blocker = plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_5", permissionID: "request" },
      },
    });
    resolveSessionLookup?.();
    await Promise.all([created, blocker]);

    const events = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);

    expect(events).toEqual(["session.created", "permission.asked"]);
  });

  test("allows hard terminal evidence through idle and then rejects late blockers", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_6" } },
    });
    await plugin.event({
      event: { type: "session.error", properties: { sessionID: "ses_6" } },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "ses_6", permissionID: "late" },
      },
    });

    const events = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);

    expect(events).toEqual(["session.idle", "session.error"]);
  });

  test("reactivates an errored generation only through chat before accepting a new blocker", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: { type: "session.error", properties: { sessionID: "ses_7" } },
    });
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_7" } },
    });
    await plugin["tool.execute.after"]({ sessionID: "ses_7" });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_7", requestID: "late" },
      },
    });
    await plugin["chat.message"]({ sessionID: "ses_7" });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "ses_7", requestID: "fresh" },
      },
    });

    const records = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.map((record) => record.event)).toEqual([
      "session.error",
      "chat.message",
      "question.asked",
    ]);
    expect(records[2]).toMatchObject({
      state: "waiting_for_permission",
      request_id: "fresh",
      blocker_kind: "question",
    });
  });

  test("accepts raw UserPromptSubmit as hard-terminal generation reactivation", async () => {
    const stateHome = mkdtempSync(join(tmpdir(), "ccmon-plugin-status-"));
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
      },
      directory: "/home/user/project",
      worktree: "/home/user/project",
      $: {},
    });

    await plugin.event({
      event: { type: "session.error", properties: { sessionID: "ses_8" } },
    });
    await plugin.event({
      event: {
        type: "UserPromptSubmit",
        properties: { sessionID: "ses_8" },
      },
    });

    const records = readFileSync(
      join(stateHome, "ccmon", "opencode-status.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.map((record) => record.event)).toEqual([
      "session.error",
      "UserPromptSubmit",
    ]);
    expect(records[1].state).toBe("running");
  });
});

describe("ccmon OpenCode plugin tool heartbeats", () => {
  const previousStateHome = process.env.XDG_STATE_HOME;
  const activePlugins = new Set<{ dispose: () => Promise<void> }>();
  let nextStateHome = 0;

  afterEach(async () => {
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
      resetHeartbeatSink();
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
        "failed to clean up OpenCode heartbeat test state",
      );
    }
  });

  async function createPlugin() {
    const stateHome = `/virtual/ccmon-plugin-tool-${nextStateHome}`;
    nextStateHome += 1;
    heartbeatSink.active = true;
    heartbeatSink.stateHome = stateHome;
    process.env.XDG_STATE_HOME = stateHome;
    const plugin = await ccmonPlugin({
      client: {
        session: { get: async () => null },
        app: { log: () => {} },
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

  function records(statusPath: string) {
    return (heartbeatSink.statusLogs.get(statusPath) ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  test("writes an immediate start, waits 30 seconds, and shares heartbeats across concurrent calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();

    await plugin["tool.execute.before"]({
      sessionID: "tool-session",
      input: { tool: "write", callID: "call-a" },
    });
    await plugin["tool.execute.before"]({
      sessionID: "tool-session",
      input: { tool: "write", callID: "call-a" },
    });
    await plugin["tool.execute.before"]({
      sessionID: "tool-session",
      input: { tool: "write", callID: "call-b" },
    });
    expect(records(statusPath).map((record) => record.event)).toEqual([
      "tool.execute.before",
      "tool.execute.before",
    ]);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(records(statusPath)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await plugin["tool.execute.after"]({
      sessionID: "tool-session",
      input: { callID: "call-a" },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await plugin["tool.execute.after"]({
      sessionID: "tool-session",
      input: { callID: "call-b" },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(records(statusPath).map((record) => record.event)).toEqual([
      "tool.execute.before",
      "tool.execute.before",
      "tool.execute.heartbeat",
      "tool.execute.heartbeat",
      "tool.execute.heartbeat",
    ]);
  });

  test("deduplicates ordinary same-state records while forcing tool starts", async () => {
    const { plugin, statusPath } = await createPlugin();

    await plugin["chat.message"]({ sessionID: "dedup-session" });
    await plugin["chat.message"]({ sessionID: "dedup-session" });
    await plugin["tool.execute.before"]({
      sessionID: "dedup-session",
      input: { callID: "call-a" },
    });
    await plugin["tool.execute.before"]({
      sessionID: "dedup-session",
      input: { callID: "call-b" },
    });

    expect(records(statusPath).map((record) => record.event)).toEqual([
      "chat.message",
      "tool.execute.before",
      "tool.execute.before",
    ]);
  });

  test("pauses active tools for blockers, resumes after the final matching resolution, and rejects stale heartbeats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();
    await plugin["tool.execute.before"]({
      sessionID: "blocked-tool",
      input: { callID: "call-a" },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "blocked-tool", permissionID: "permission-a" },
      },
    });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "blocked-tool", requestID: "question-a" },
      },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "blocked-tool", permissionID: "permission-a" },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await plugin.event({
      event: {
        type: "question.rejected",
        properties: { sessionID: "blocked-tool", requestID: "question-a" },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(records(statusPath).map((record) => record.event)).toEqual([
      "tool.execute.before",
      "tool.execute.heartbeat",
      "permission.asked",
      "question.asked",
      "permission.replied",
      "question.rejected",
      "tool.execute.heartbeat",
    ]);
  });

  test.each([
    {
      askEvent: "question.asked",
      resolveEvent: "question.replied",
      resolveProperties: { requestID: "question-request" },
    },
    {
      askEvent: "permission.asked",
      resolveEvent: "permission.rejected",
      resolveProperties: { permissionID: "permission-request" },
    },
  ])("resumes tool heartbeats when $resolveEvent clears a same-kind legacy blocker", async ({
    askEvent,
    resolveEvent,
    resolveProperties,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();
    const sessionID = `legacy-${askEvent}`;

    await plugin["tool.execute.before"]({
      sessionID,
      input: { callID: "call" },
    });
    await plugin.event({
      event: { type: askEvent, properties: { sessionID } },
    });
    await plugin.event({
      event: {
        type: resolveEvent,
        properties: { sessionID, ...resolveProperties },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath)
        .filter((record) => record.session_id === sessionID)
        .map((record) => record.event),
    ).toEqual([
      "tool.execute.before",
      askEvent,
      resolveEvent,
      "tool.execute.heartbeat",
    ]);
  });

  test("prefers an exact keyed resolution over the same-kind legacy fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();

    await plugin["tool.execute.before"]({
      sessionID: "exact-before-legacy",
      input: { callID: "call" },
    });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "exact-before-legacy" },
      },
    });
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "exact-before-legacy", id: "keyed" },
      },
    });
    await plugin.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "exact-before-legacy", requestID: "keyed" },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "exact-before-legacy" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(0);

    await plugin.event({
      event: {
        type: "question.rejected",
        properties: { sessionID: "exact-before-legacy", requestID: "unknown" },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "exact-before-legacy" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(1);
  });

  test("does not let a keyed question resolver clear a legacy permission blocker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();

    await plugin["tool.execute.before"]({
      sessionID: "kind-isolated-legacy",
      input: { callID: "call" },
    });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "kind-isolated-legacy" },
      },
    });
    await plugin.event({
      event: {
        type: "question.rejected",
        properties: {
          sessionID: "kind-isolated-legacy",
          requestID: "question-request",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "kind-isolated-legacy" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(0);

    await plugin.event({
      event: {
        type: "permission.rejected",
        properties: {
          sessionID: "kind-isolated-legacy",
          permissionID: "permission-request",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "kind-isolated-legacy" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(1);
  });

  test("reactivation clears prior blockers and accepts only new-generation blockers", async () => {
    const { plugin, statusPath } = await createPlugin();
    await plugin.event({
      event: {
        type: "question.asked",
        properties: { sessionID: "reactivated", requestID: "old-question" },
      },
    });
    await plugin["chat.message"]({ sessionID: "reactivated" });
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: {
          sessionID: "reactivated",
          permissionID: "new-permission",
        },
      },
    });

    expect(records(statusPath)).toMatchObject([
      {
        event: "question.asked",
        state: "waiting_for_permission",
        request_id: "old-question",
      },
      { event: "chat.message", state: "running" },
      {
        event: "permission.asked",
        state: "waiting_for_permission",
        request_id: "new-permission",
      },
    ]);
  });

  test("anonymous completed tool parts clear one call but preserve ambiguous concurrent calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();
    await plugin["tool.execute.before"]({
      sessionID: "single-call",
      input: { callID: "single" },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "single-call",
          part: { type: "tool", status: "error" },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await plugin["tool.execute.before"]({
      sessionID: "many-calls",
      input: { callID: "first" },
    });
    await plugin["tool.execute.before"]({
      sessionID: "many-calls",
      input: { callID: "second" },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "many-calls",
          part: { type: "tool", status: "completed" },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "single-call" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(0);
    expect(
      records(statusPath).filter(
        (record) =>
          record.session_id === "many-calls" &&
          record.event === "tool.execute.heartbeat",
      ),
    ).toHaveLength(1);
  });

  test("cleans timers for tool parts, terminal events, disposal, and queued old generations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const { plugin, statusPath } = await createPlugin();

    await plugin["tool.execute.before"]({
      sessionID: "part-session",
      input: { callID: "part-call" },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "part-session",
          part: { type: "tool", callID: "part-call", status: "completed" },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await plugin["tool.execute.before"]({
      sessionID: "idle-session",
      input: { callID: "idle-call" },
    });
    vi.advanceTimersByTime(30_000);
    await plugin.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "idle-session" },
      },
    });
    await Promise.resolve();

    await plugin["tool.execute.before"]({
      sessionID: "error-session",
      input: { callID: "error-call" },
    });
    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "error-session" },
      },
    });
    await plugin["tool.execute.before"]({
      sessionID: "delete-session",
      input: { callID: "delete-call" },
    });
    await plugin.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "delete-session" },
      },
    });
    await plugin["tool.execute.before"]({
      sessionID: "dispose-session",
      input: { callID: "dispose-call" },
    });
    await plugin.dispose();
    await vi.advanceTimersByTimeAsync(90_000);

    const events = records(statusPath).map((record) => [
      record.session_id,
      record.event,
    ]);
    expect(events).toContainEqual(["part-session", "tool.execute.before"]);
    expect(events).toContainEqual(["idle-session", "session.idle"]);
    expect(events).toContainEqual(["error-session", "session.error"]);
    expect(events).toContainEqual(["delete-session", "session.deleted"]);
    expect(
      events.filter(([, event]) => event === "tool.execute.heartbeat"),
    ).toHaveLength(0);
  });

  test("records deletion after error and does not retain terminal session timers", async () => {
    vi.useFakeTimers();
    const { plugin, statusPath } = await createPlugin();

    for (let index = 0; index < 1_500; index += 1) {
      const sessionID = `terminal-${index}`;
      await plugin["tool.execute.before"]({
        sessionID,
        input: { callID: `call-${index}` },
      });
      await plugin.event({
        event: { type: "session.error", properties: { sessionID } },
      });
    }
    await plugin.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "terminal-1499" },
      },
    });
    await vi.advanceTimersByTimeAsync(90_000);

    expect(
      records(statusPath)
        .filter((record) => record.session_id === "terminal-1499")
        .map((record) => record.event),
    ).toEqual(["tool.execute.before", "session.error", "session.deleted"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
