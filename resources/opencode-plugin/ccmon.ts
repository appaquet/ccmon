import { appendFile, mkdir } from "node:fs/promises";

type SessionState = "running" | "waiting_for_permission" | "stopped" | "closed" | "error";

interface SessionInfo {
  id: string;
  parentID?: string;
  directory?: string;
}

interface EventProperties {
  sessionID?: string;
  info?: SessionInfo;
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

export async function ccmonPlugin(context: PluginContext) {
  const { client, directory } = context;

  const sessionCwdMap = new Map<string, string>();
  const lastWrittenState = new Map<string, SessionState>();

  const home = process.env.HOME;
  const logDir = home
    ? `${home}/.local/state/ccmon`
    : `${directory}/.opencode`;
  const logPath = `${logDir}/opencode-status.jsonl`;

  await mkdir(logDir, { recursive: true }).catch(() => {});

  function extractSessionId(ctx: EventHandlerContext | HookHandlerContext): string | undefined {
    const c = ctx as Record<string, unknown>;
    const evt = c.event as Record<string, unknown> | undefined;
    const props = evt?.properties as Record<string, unknown> | undefined;
    const info = props?.info as Record<string, unknown> | undefined;

    if (typeof props?.sessionID === "string") return props.sessionID;
    if (typeof info?.id === "string") return info.id;
    if (typeof c.sessionID === "string") return c.sessionID;
    return undefined;
  }

  async function writeStatus(
    sessionId: string,
    state: SessionState,
    eventType: string,
    cwd?: string,
  ): Promise<void> {
    if (!sessionId || !state) return;

    const previousState = lastWrittenState.get(sessionId);
    if (previousState === state) return;

    const resolvedCwd = cwd ?? sessionCwdMap.get(sessionId) ?? directory;

    const line = JSON.stringify({
      session_id: sessionId,
      working_dir: resolvedCwd,
      state,
      timestamp: new Date().toISOString(),
      event: eventType,
    });

    try {
      await appendFile(logPath, `${line}\n`);
      lastWrittenState.set(sessionId, state);
    } catch (err) {
      client.app.log({
        level: "error",
        message: `ccmon: failed to write status: ${String(err)}`,
      });
    }
  }

  async function onSessionCreated(props: EventProperties | undefined): Promise<void> {
    const info = props?.info;
    if (!info?.id) return;

    const sessionId = info.id;

    if (info.parentID) {
      const parentCwd = sessionCwdMap.get(info.parentID) ?? directory;
      sessionCwdMap.set(sessionId, parentCwd);
      await writeStatus(info.parentID, "running", "session.created", parentCwd);
      return;
    }

    let cwd: string | undefined = info.directory;
    if (!cwd) {
      try {
        const s = await client.session.get({ path: { id: sessionId } });
        cwd = s?.directory;
      } catch {
        // fall through to context.directory
      }
    }
    cwd = cwd || directory;

    sessionCwdMap.set(sessionId, cwd);
    await writeStatus(sessionId, "running", "session.created", cwd);
  }

  return {
    event: async (ctx: EventHandlerContext) => {
      try {
        const type = ctx.event?.type;
        if (!type) return;

        switch (type) {
          case "session.created": {
            await onSessionCreated(ctx.event.properties);
            break;
          }
          case "session.idle": {
            const sid = extractSessionId(ctx);
            if (sid) await writeStatus(sid, "stopped", type);
            break;
          }
          case "session.error": {
            const sid = extractSessionId(ctx);
            if (sid) await writeStatus(sid, "error", type);
            break;
          }
          case "session.deleted": {
            const sid = extractSessionId(ctx);
            if (sid) {
              await writeStatus(sid, "closed", type);
              sessionCwdMap.delete(sid);
              lastWrittenState.delete(sid);
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

    "chat.message": async (ctx: HookHandlerContext) => {
      try {
        const sid = extractSessionId(ctx);
        if (!sid) return;

        const parts = ctx.input?.parts;
        if (!Array.isArray(parts)) return;

        const isUserMessage = parts.some(
          (p) => p.type === "text" && p.source?.type === "user",
        );
        if (!isUserMessage) return;

        const cwd = sessionCwdMap.get(sid) ?? directory;
        await writeStatus(sid, "running", "chat.message", cwd);
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: chat.message error: ${String(err)}`,
        });
      }
    },

    "tool.execute.after": async (ctx: HookHandlerContext) => {
      try {
        const sid = extractSessionId(ctx);
        if (!sid) return;

        const cwd = sessionCwdMap.get(sid) ?? directory;
        await writeStatus(sid, "running", "tool.execute.after", cwd);
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: tool.execute.after error: ${String(err)}`,
        });
      }
    },

    "permission.ask": async (ctx: HookHandlerContext) => {
      try {
        const sid = extractSessionId(ctx);
        if (!sid) return;

        const cwd = sessionCwdMap.get(sid) ?? directory;
        await writeStatus(sid, "waiting_for_permission", "permission.ask", cwd);
      } catch (err) {
        client.app.log({
          level: "error",
          message: `ccmon: permission.ask error: ${String(err)}`,
        });
      }
    },
  };
}
