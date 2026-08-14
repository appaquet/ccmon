import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type SessionState =
  | "running"
  | "waiting_for_permission"
  | "stopped"
  | "closed"
  | "error";

type LifecycleMode = "active" | "idle" | "hard_terminal";
type BlockerKind = "question" | "permission";
type BlockerLifecycle = {
  action: "ask" | "resolve";
  key: string;
  kind: BlockerKind;
};

interface SessionInfo {
  id: string;
  parentID?: string;
  directory?: string;
}

interface EventProperties {
  sessionID?: string;
  sessionId?: string;
  permissionID?: string;
  permissionId?: string;
  requestID?: string;
  requestId?: string;
  callID?: string;
  callId?: string;
  id?: string;
  info?: SessionInfo;
  part?: Record<string, unknown>;
  status?: string;
  error?: unknown;
}

interface PluginEvent {
  type: string;
  properties?: EventProperties;
}

interface EventHandlerContext {
  event: PluginEvent;
}

interface HookHandlerContext {
  sessionID?: string;
  input?: Record<string, unknown> & {
    parts?: Array<{ type?: string; source?: { type?: string } }>;
    tool?: string;
  };
}

interface PluginClient {
  session: {
    get: (opts: { path: { id: string } }) => Promise<SessionInfo | null>;
  };
  app: {
    log: (opts: { level: string; message: string }) => void;
  };
}

interface PluginContext {
  client: PluginClient;
  directory: string;
  worktree: string;
  $: unknown;
}

type InFlightSession = {
  activeCallIds: Set<string>;
  blockers: Set<string>;
  generation: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatWritePending: boolean;
  pendingWrites: number;
};

type StatusRecord = {
  event: string;
  session_id?: string;
  working_dir?: string;
  state: SessionState;
  timestamp: string;
  active_sessions?: number;
  request_id?: string;
  blocker_kind?: BlockerKind;
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const PLUGIN_HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_CACHE_LIMIT = 1_024;
const TERMINAL_BARRIER_LIMIT = 1_024;
const LEGACY_REQUEST_SLOT = "__ccmon_legacy_request__";

/** Caps only queued heartbeat writes; lifecycle records are never dropped. */
const MAX_PENDING_WRITES = 256;

export async function ccmonPlugin(context: PluginContext) {
  const { client, directory } = context;
  const sessionCwdMap = new Map<string, string>();
  const lastWrittenState = new Map<string, SessionState>();
  const lastForcedLivenessBySession = new Map<string, number>();
  const lifecycleModes = new Map<string, LifecycleMode>();
  const inFlightBySession = new Map<string, InFlightSession>();
  let writeQueue: Promise<void> = Promise.resolve();
  let pendingHeartbeatCount = 0;
  let pluginHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const logDir = join(stateHome, "ccmon");
  const logPath = join(logDir, "opencode-status.jsonl");

  await mkdir(logDir, { recursive: true }).catch(() => {});
  queuePluginHeartbeat();
  pluginHeartbeatTimer = setInterval(
    () => queuePluginHeartbeat(),
    PLUGIN_HEARTBEAT_INTERVAL_MS,
  );
  (pluginHeartbeatTimer as { unref?: () => void }).unref?.();

  function setBoundedSessionValue<T>(
    map: Map<string, T>,
    sessionId: string,
    value: T,
  ): void {
    map.delete(sessionId);
    map.set(sessionId, value);
    while (map.size > SESSION_CACHE_LIMIT) {
      const oldestSessionId = map.keys().next().value;
      if (oldestSessionId === undefined) break;
      map.delete(oldestSessionId);
    }
  }

  function logBackpressure(message: string): void {
    client.app.log({ level: "warn", message: `ccmon: ${message}` });
  }

  function trackerFor(sessionId: string): InFlightSession {
    const existing = inFlightBySession.get(sessionId);
    if (existing) return existing;

    const tracker: InFlightSession = {
      activeCallIds: new Set(),
      blockers: new Set(),
      generation: 0,
      heartbeatTimer: null,
      heartbeatWritePending: false,
      pendingWrites: 0,
    };
    inFlightBySession.set(sessionId, tracker);
    return tracker;
  }

  function extractSessionId(
    ctx: EventHandlerContext | HookHandlerContext,
  ): string | undefined {
    const c = ctx as Record<string, unknown>;
    const evt = c.event as Record<string, unknown> | undefined;
    const props = evt?.properties as Record<string, unknown> | undefined;
    const info = props?.info as Record<string, unknown> | undefined;

    if (typeof props?.sessionID === "string") return props.sessionID;
    if (typeof props?.sessionId === "string") return props.sessionId;
    const part = props?.part as Record<string, unknown> | undefined;
    if (typeof part?.sessionID === "string") return part.sessionID;
    if (typeof part?.sessionId === "string") return part.sessionId;
    if (typeof info?.id === "string") return info.id;
    if (typeof c.sessionID === "string") return c.sessionID;
    return undefined;
  }

  function extractRequestId(
    ctx: EventHandlerContext | HookHandlerContext,
  ): string | undefined {
    const c = ctx as Record<string, unknown>;
    const evt = c.event as Record<string, unknown> | undefined;
    const props = evt?.properties as Record<string, unknown> | undefined;
    const input = c.input as Record<string, unknown> | undefined;
    for (const candidate of [
      props?.permissionID,
      props?.permissionId,
      props?.requestID,
      props?.requestId,
      input?.permissionID,
      input?.permissionId,
      input?.requestID,
      input?.requestId,
    ]) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    return undefined;
  }

  function extractBlockerAskRequestId(
    ctx: EventHandlerContext,
  ): string | undefined {
    const requestId = extractRequestId(ctx);
    if (requestId) return requestId;

    const properties = ctx.event.properties as
      | Record<string, unknown>
      | undefined;
    return typeof properties?.id === "string" && properties.id.length > 0
      ? properties.id
      : undefined;
  }

  function extractCallId(
    ctx: EventHandlerContext | HookHandlerContext,
  ): string | undefined {
    const c = ctx as Record<string, unknown>;
    const event = c.event as Record<string, unknown> | undefined;
    const properties = event?.properties as Record<string, unknown> | undefined;
    const input = c.input as Record<string, unknown> | undefined;
    const part = properties?.part as Record<string, unknown> | undefined;
    for (const candidate of [
      properties?.callID,
      properties?.callId,
      input?.callID,
      input?.callId,
      part?.callID,
      part?.callId,
      part?.id,
    ]) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    return undefined;
  }

  function getLifecycle(
    eventType: string,
    kind: BlockerKind | undefined,
    requestId: string | undefined,
  ): BlockerLifecycle | null {
    if (!kind) return null;
    const key = `${kind}\u0000${requestId || LEGACY_REQUEST_SLOT}`;
    if (
      eventType === "question.asked" ||
      eventType === "permission.asked" ||
      eventType === "permission.ask"
    ) {
      return { action: "ask", key, kind };
    }
    if (
      eventType === "question.replied" ||
      eventType === "question.rejected" ||
      eventType === "permission.replied" ||
      eventType === "permission.rejected"
    ) {
      return { action: "resolve", key, kind };
    }
    return null;
  }

  function isGenerationReactivation(eventType: string): boolean {
    return (
      eventType === "chat.message" ||
      eventType === "UserPromptSubmit" ||
      eventType === "session.created"
    );
  }

  function isIdleReactivation(eventType: string): boolean {
    return (
      isGenerationReactivation(eventType) ||
      eventType === "session.status" ||
      eventType === "message.part.updated"
    );
  }

  function stopHeartbeat(tracker: InFlightSession): void {
    if (tracker.heartbeatTimer !== null) {
      clearInterval(tracker.heartbeatTimer);
      tracker.heartbeatTimer = null;
    }
  }

  function resetSessionGeneration(sessionId: string): InFlightSession {
    const tracker = trackerFor(sessionId);
    tracker.generation += 1;
    tracker.activeCallIds.clear();
    tracker.blockers.clear();
    stopHeartbeat(tracker);
    lifecycleModes.set(sessionId, "active");
    return tracker;
  }

  function clearSessionTools(sessionId: string): InFlightSession {
    const tracker = trackerFor(sessionId);
    tracker.generation += 1;
    tracker.activeCallIds.clear();
    tracker.blockers.clear();
    stopHeartbeat(tracker);
    return tracker;
  }

  function cleanupTerminalSession(
    sessionId: string,
    state: "stopped" | "closed" | "error",
  ): void {
    const tracker = inFlightBySession.get(sessionId);
    if (tracker) {
      stopHeartbeat(tracker);
      inFlightBySession.delete(sessionId);
    }
    sessionCwdMap.delete(sessionId);
    lastWrittenState.delete(sessionId);
    lastForcedLivenessBySession.delete(sessionId);
    const mode = state === "stopped" ? "idle" : "hard_terminal";
    lifecycleModes.delete(sessionId);
    lifecycleModes.set(sessionId, mode);
    while (lifecycleModes.size > TERMINAL_BARRIER_LIMIT) {
      const oldestSessionId = lifecycleModes.keys().next().value;
      if (oldestSessionId === undefined) break;
      lifecycleModes.delete(oldestSessionId);
    }
  }

  function cleanupIdleSession(
    sessionId: string,
    tracker = inFlightBySession.get(sessionId),
  ): void {
    if (
      !tracker ||
      tracker.activeCallIds.size > 0 ||
      tracker.blockers.size > 0 ||
      tracker.heartbeatTimer !== null ||
      tracker.heartbeatWritePending ||
      tracker.pendingWrites > 0 ||
      (lifecycleModes.get(sessionId) ?? "active") !== "active"
    ) {
      return;
    }
    inFlightBySession.delete(sessionId);
    lifecycleModes.delete(sessionId);
  }

  function startHeartbeat(sessionId: string): void {
    const tracker = inFlightBySession.get(sessionId);
    if (!tracker) return;
    if (
      disposed ||
      tracker.heartbeatTimer !== null ||
      tracker.activeCallIds.size === 0 ||
      tracker.blockers.size > 0 ||
      (lifecycleModes.get(sessionId) ?? "active") !== "active"
    ) {
      return;
    }
    tracker.heartbeatTimer = setInterval(
      () => queueHeartbeat(sessionId),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  function enqueueRecord(
    record: StatusRecord,
    force: boolean,
    isCurrent: () => boolean = () => true,
    onSettled?: () => void,
    tracker?: InFlightSession,
  ): Promise<void> {
    const isHeartbeat =
      record.event === "tool.execute.heartbeat" ||
      record.event === "plugin.heartbeat";
    if (isHeartbeat && pendingHeartbeatCount >= MAX_PENDING_WRITES) {
      logBackpressure(
        `heartbeat write queue is full; dropping ${record.event}${record.session_id ? ` for ${record.session_id}` : ""}`,
      );
      onSettled?.();
      return Promise.resolve();
    }

    if (isHeartbeat) pendingHeartbeatCount += 1;
    if (tracker) tracker.pendingWrites += 1;
    writeQueue = writeQueue.then(async () => {
      try {
        if (!isCurrent()) return;
        if (
          !force &&
          record.session_id !== undefined &&
          lastWrittenState.get(record.session_id) === record.state
        ) {
          return;
        }
        await appendRecord(record);
        if (record.session_id !== undefined) {
          setBoundedSessionValue(
            lastWrittenState,
            record.session_id,
            record.state,
          );
        }
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: failed to write status: ${String(err)}`,
        });
      } finally {
        if (isHeartbeat) pendingHeartbeatCount -= 1;
        if (tracker) tracker.pendingWrites -= 1;
        onSettled?.();
      }
    });
    return writeQueue;
  }

  function countActiveSessions(): number {
    let count = 0;
    for (const tracker of inFlightBySession.values()) {
      if (tracker.activeCallIds.size > 0) count += 1;
    }
    return count;
  }

  function queuePluginHeartbeat(): Promise<void> {
    if (disposed) return Promise.resolve();
    return enqueueRecord(
      {
        event: "plugin.heartbeat",
        state: "running",
        timestamp: new Date().toISOString(),
        active_sessions: countActiveSessions(),
      },
      true,
      () => !disposed,
    );
  }

  function queueHeartbeat(sessionId: string): Promise<void> {
    const tracker = inFlightBySession.get(sessionId);
    if (!tracker) return Promise.resolve();
    if (
      disposed ||
      tracker.heartbeatWritePending ||
      tracker.activeCallIds.size === 0 ||
      tracker.blockers.size > 0 ||
      (lifecycleModes.get(sessionId) ?? "active") !== "active"
    ) {
      return Promise.resolve();
    }
    const generation = tracker.generation;
    tracker.heartbeatWritePending = true;
    const cwd = sessionCwdMap.get(sessionId) ?? directory;
    return enqueueRecord(
      statusRecord(sessionId, "running", "tool.execute.heartbeat", cwd),
      true,
      () => {
        const current = inFlightBySession.get(sessionId);
        return (
          !disposed &&
          current === tracker &&
          current.generation === generation &&
          current.activeCallIds.size > 0 &&
          current.blockers.size === 0 &&
          (lifecycleModes.get(sessionId) ?? "active") === "active"
        );
      },
      () => {
        if (inFlightBySession.get(sessionId) === tracker) {
          tracker.heartbeatWritePending = false;
          cleanupIdleSession(sessionId, tracker);
        }
      },
      tracker,
    );
  }

  function queueForcedLiveness(
    sessionId: string,
    eventType: "session.status" | "message.part.updated",
  ): Promise<void> {
    const mode = lifecycleModes.get(sessionId) ?? "active";
    if (disposed || mode === "hard_terminal") return Promise.resolve();

    const now = Date.now();
    const lastForcedLivenessMs = lastForcedLivenessBySession.get(sessionId);
    if (
      lastForcedLivenessMs !== undefined &&
      now - lastForcedLivenessMs < HEARTBEAT_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    setBoundedSessionValue(lastForcedLivenessBySession, sessionId, now);
    return writeStatus(
      sessionId,
      "running",
      eventType,
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  function statusRecord(
    sessionId: string,
    state: SessionState,
    eventType: string,
    cwd?: string,
    requestId?: string,
    blockerKind?: BlockerKind,
  ): StatusRecord {
    return {
      session_id: sessionId,
      working_dir: cwd ?? sessionCwdMap.get(sessionId) ?? directory,
      state,
      timestamp: new Date().toISOString(),
      event: eventType,
      ...(requestId ? { request_id: requestId } : {}),
      ...(blockerKind ? { blocker_kind: blockerKind } : {}),
    };
  }

  function writeStatus(
    sessionId: string,
    state: SessionState,
    eventType: string,
    cwd?: string,
    requestId?: string,
    blockerKind?: BlockerKind,
    force = false,
  ): Promise<void> {
    if (!sessionId || disposed) return Promise.resolve();

    const mode = lifecycleModes.get(sessionId) ?? "active";
    const isReactivation = isGenerationReactivation(eventType);
    const isIdleReactivationEvent = isIdleReactivation(eventType);
    if (
      mode === "hard_terminal" &&
      !isReactivation &&
      !(state === "closed" && eventType === "session.deleted")
    ) {
      return Promise.resolve();
    }
    if (
      mode === "idle" &&
      !isIdleReactivationEvent &&
      state !== "error" &&
      state !== "closed"
    ) {
      return Promise.resolve();
    }

    const tracker = trackerFor(sessionId);
    const lifecycle = getLifecycle(eventType, blockerKind, requestId);
    const isTerminal =
      state === "stopped" || state === "closed" || state === "error";
    if (eventType === "session.created") {
      resetSessionGeneration(sessionId);
    } else if (isReactivation) {
      resetSessionGeneration(sessionId);
    } else if (mode === "idle") {
      resetSessionGeneration(sessionId);
    }

    if (isTerminal) {
      lifecycleModes.set(
        sessionId,
        state === "stopped" ? "idle" : "hard_terminal",
      );
    } else if (lifecycle?.action === "ask") {
      if (!tracker.blockers.has(lifecycle.key)) tracker.generation += 1;
      tracker.blockers.add(lifecycle.key);
      stopHeartbeat(tracker);
    } else if (lifecycle?.action === "resolve") {
      const wasBlocked =
        tracker.blockers.delete(lifecycle.key) ||
        (requestId !== undefined &&
          tracker.blockers.delete(
            `${lifecycle.kind}\u0000${LEGACY_REQUEST_SLOT}`,
          ));
      if (wasBlocked && tracker.blockers.size === 0) {
        startHeartbeat(sessionId);
      }
    }

    if (
      state === "running" &&
      lifecycle === null &&
      ((lifecycleModes.get(sessionId) ?? "active") !== "active" ||
        tracker.blockers.size !== 0)
    ) {
      return Promise.resolve();
    }

    const generation = tracker?.generation;
    const isCurrent =
      state === "running" &&
      lifecycle === null &&
      eventType !== "session.created"
        ? () => {
            if (
              disposed ||
              (lifecycleModes.get(sessionId) ?? "active") !== "active"
            ) {
              return false;
            }
            const current = inFlightBySession.get(sessionId);
            return (
              current === tracker &&
              current.generation === generation &&
              current.blockers.size === 0
            );
          }
        : () => true;

    const queued = enqueueRecord(
      statusRecord(sessionId, state, eventType, cwd, requestId, blockerKind),
      force,
      isCurrent,
      () => cleanupIdleSession(sessionId, tracker),
      tracker,
    );
    if (lifecycle?.action === "resolve") {
      return queued.then(() => cleanupIdleSession(sessionId, tracker));
    }
    return queued;
  }

  function beginTool(sessionId: string, callId: string): Promise<void> {
    if (disposed || (lifecycleModes.get(sessionId) ?? "active") !== "active") {
      return Promise.resolve();
    }
    const tracker = trackerFor(sessionId);
    if (tracker.activeCallIds.has(callId)) return Promise.resolve();
    tracker.activeCallIds.add(callId);
    startHeartbeat(sessionId);
    return writeStatus(
      sessionId,
      "running",
      "tool.execute.before",
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  function finishTool(sessionId: string, callId: string | undefined): void {
    const tracker = inFlightBySession.get(sessionId);
    if (!tracker) return;
    if (callId) {
      tracker.activeCallIds.delete(callId);
    } else if (tracker.activeCallIds.size === 1) {
      tracker.activeCallIds.clear();
    }
    if (tracker.activeCallIds.size === 0) {
      stopHeartbeat(tracker);
      cleanupIdleSession(sessionId, tracker);
    }
  }

  function isCompletedToolPart(ctx: EventHandlerContext): boolean {
    const props = ctx.event.properties as Record<string, unknown> | undefined;
    const part = props?.part as Record<string, unknown> | undefined;
    const status = part?.state ?? part?.status ?? props?.state ?? props?.status;
    const type = part?.type ?? props?.type;
    return (
      (type === "tool" || extractCallId(ctx) !== undefined) &&
      (status === "completed" || status === "error")
    );
  }

  async function onSessionCreated(
    props: EventProperties | undefined,
  ): Promise<void> {
    const info = props?.info;
    if (!info?.id) return;
    const sessionId = info.id;

    if (info.parentID) {
      const parentCwd = sessionCwdMap.get(info.parentID) ?? directory;
      setBoundedSessionValue(sessionCwdMap, sessionId, parentCwd);
      await writeStatus(
        sessionId,
        "running",
        "session.created",
        parentCwd,
        undefined,
        undefined,
        true,
      );
      await writeStatus(
        info.parentID,
        "running",
        "subagent.created",
        parentCwd,
      );
      return;
    }

    let cwd = info.directory ?? directory;
    setBoundedSessionValue(sessionCwdMap, sessionId, cwd);
    await writeStatus(
      sessionId,
      "running",
      "session.created",
      cwd,
      undefined,
      undefined,
      true,
    );
    if (!info.directory) {
      try {
        const session = await client.session.get({ path: { id: sessionId } });
        if (session?.directory) {
          cwd = session.directory;
          setBoundedSessionValue(sessionCwdMap, sessionId, cwd);
        }
      } catch {
        // The context directory remains the safe fallback.
      }
    }
  }

  return {
    event: async (ctx: EventHandlerContext) => {
      try {
        const type = ctx.event?.type;
        if (!type || disposed) return;
        switch (type) {
          case "session.created":
            await onSessionCreated(ctx.event.properties);
            break;
          case "session.idle": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) {
              clearSessionTools(sessionId);
              await writeStatus(sessionId, "stopped", type);
              cleanupTerminalSession(sessionId, "stopped");
            }
            break;
          }
          case "session.status": {
            const sessionId = extractSessionId(ctx);
            const status = ctx.event.properties?.status;
            if (sessionId && (status === "busy" || status === "retry")) {
              await queueForcedLiveness(sessionId, type);
            }
            break;
          }
          case "session.error": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) {
              clearSessionTools(sessionId);
              await writeStatus(sessionId, "error", type);
              cleanupTerminalSession(sessionId, "error");
            }
            break;
          }
          case "session.deleted": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) {
              clearSessionTools(sessionId);
              await writeStatus(sessionId, "closed", type);
              cleanupTerminalSession(sessionId, "closed");
            }
            break;
          }
          case "UserPromptSubmit": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) await writeStatus(sessionId, "running", type);
            break;
          }
          case "permission.asked":
          case "question.asked": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) {
              const blockerKind = type.startsWith("question")
                ? "question"
                : "permission";
              await writeStatus(
                sessionId,
                "waiting_for_permission",
                type,
                undefined,
                extractBlockerAskRequestId(ctx),
                blockerKind,
                true,
              );
            }
            break;
          }
          case "permission.replied":
          case "question.replied":
          case "question.rejected":
          case "permission.rejected": {
            const sessionId = extractSessionId(ctx);
            if (sessionId) {
              const blockerKind = type.startsWith("question")
                ? "question"
                : "permission";
              await writeStatus(
                sessionId,
                "running",
                type,
                undefined,
                extractRequestId(ctx),
                blockerKind,
                true,
              );
            }
            break;
          }
          case "message.part.updated": {
            const sessionId = extractSessionId(ctx);
            if (sessionId && isCompletedToolPart(ctx)) {
              finishTool(sessionId, extractCallId(ctx));
            } else if (sessionId) {
              await queueForcedLiveness(sessionId, type);
            }
            break;
          }
        }
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: event handler error: ${String(err)}`,
        });
      }
    },

    "chat.message": async (input: { sessionID?: string }) => {
      try {
        if (input?.sessionID)
          await writeStatus(input.sessionID, "running", "chat.message");
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: chat.message error: ${String(err)}`,
        });
      }
    },

    "tool.execute.before": async (ctx: HookHandlerContext) => {
      try {
        const sessionId = extractSessionId(ctx);
        const callId = extractCallId(ctx);
        if (sessionId && callId) await beginTool(sessionId, callId);
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: tool.execute.before error: ${String(err)}`,
        });
      }
    },

    "tool.execute.after": async (ctx: HookHandlerContext) => {
      try {
        const sessionId = extractSessionId(ctx);
        if (sessionId) finishTool(sessionId, extractCallId(ctx));
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: tool.execute.after error: ${String(err)}`,
        });
      }
    },

    "permission.ask": async (ctx: HookHandlerContext) => {
      try {
        const sessionId = extractSessionId(ctx);
        if (sessionId) {
          await writeStatus(
            sessionId,
            "waiting_for_permission",
            "permission.ask",
            undefined,
            extractRequestId(ctx),
            "permission",
            true,
          );
        }
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: permission.ask error: ${String(err)}`,
        });
      }
    },

    dispose: async () => {
      disposed = true;
      if (pluginHeartbeatTimer !== null) {
        clearInterval(pluginHeartbeatTimer);
        pluginHeartbeatTimer = null;
      }
      for (const tracker of inFlightBySession.values()) {
        tracker.generation += 1;
        tracker.activeCallIds.clear();
        tracker.blockers.clear();
        stopHeartbeat(tracker);
      }
      await writeQueue;
    },
  };

  async function appendRecord(record: StatusRecord): Promise<void> {
    await appendFile(logPath, `${JSON.stringify(record)}\n`);
  }
}
