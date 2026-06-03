import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "../log.ts";
import { parseMessageData, parsePartData } from "../parsers/opencode-db.ts";
import {
  parseStatusLines,
  resolveState as resolveStatusLogState,
  type SessionState,
  type StatusEvent,
} from "../session-core.ts";
import {
  DEBOUNCE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  OPENCODE_ACTIVE_THRESHOLD_MS,
  STATUS_LOG_TAIL_BYTES,
  SUBAGENT_ACTIVE_THRESHOLD_MS,
  SUBAGENT_EXPIRY_MS,
} from "../timing.ts";
import type {
  NotificationMeta,
  ProjectInfo,
  SessionEnrichment,
  SubagentInfo,
} from "../types.ts";
import type { SessionBackend } from "./types.ts";

function statSyncTerse(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function resolveDefaultStatusLogPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "ccmon", "opencode-status.jsonl");
}

export class OpencodeBackend implements SessionBackend {
  private lastStatusLogMtime: number | null = null;
  private statusLogEvents: StatusEvent[] | null = null;
  private db: DatabaseSync;
  private pollIntervalMs: number;
  private statusLogPath: string;
  private statusPollIntervalMs: number;

  constructor(
    db: DatabaseSync,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    statusLogPath = resolveDefaultStatusLogPath(),
    statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
  ) {
    this.db = db;
    this.pollIntervalMs = pollIntervalMs;
    this.statusLogPath = statusLogPath;
    this.statusPollIntervalMs = statusPollIntervalMs;
  }

  async scanProjects(): Promise<ProjectInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT
           s.id AS sessionId,
           s.directory AS cwd,
           p.name AS projectName,
           s.time_created,
           s.time_updated
         FROM session s
         JOIN project p ON s.project_id = p.id
         JOIN (
           SELECT directory, MAX(time_updated) AS max_updated
           FROM session
           WHERE time_archived IS NULL AND parent_id IS NULL
           GROUP BY directory
         ) latest ON s.directory = latest.directory AND s.time_updated = latest.max_updated
         WHERE s.time_archived IS NULL
           AND s.parent_id IS NULL`,
      )
      .all() as {
      sessionId: string;
      cwd: string;
      projectName: string | null;
      time_created: number;
      time_updated: number;
    }[];

    return rows.map((row) => ({
      cwd: row.cwd,
      projectName: row.projectName ?? basename(row.cwd),
      sessionId: row.sessionId,
      source: "opencode",
    }));
  }

  async computeLastUpdated(projectInfo: ProjectInfo): Promise<string | null> {
    const row = this.db
      .prepare("SELECT time_updated, directory FROM session WHERE id = ?")
      .get(projectInfo.sessionId) as
      | { time_updated: number; directory: string }
      | undefined;

    if (!row) return null;

    const maxRow = this.db
      .prepare(
        "SELECT MAX(time_updated) AS max_updated FROM session WHERE id = ? OR parent_id = ?",
      )
      .get(projectInfo.sessionId, projectInfo.sessionId) as
      | { max_updated: number | null }
      | undefined;

    let maxUpdated = maxRow?.max_updated ?? row.time_updated;
    for (const child of this.getActiveChildActivityRows(
      projectInfo,
      row.directory,
    )) {
      maxUpdated = Math.max(maxUpdated, child.time_updated);
    }

    return new Date(maxUpdated).toISOString();
  }

  async resolveState(projectInfo: ProjectInfo): Promise<SessionState> {
    const statusState = this.resolveStatusLogState(projectInfo.sessionId);

    if (
      statusState === "running" ||
      statusState === "waiting_for_permission" ||
      statusState === "closed" ||
      statusState === "error"
    ) {
      return statusState;
    }

    const row = this.db
      .prepare(
        `SELECT time_updated, time_archived, directory FROM session WHERE id = ?`,
      )
      .get(projectInfo.sessionId) as
      | {
          time_updated: number;
          time_archived: number | null;
          directory: string;
        }
      | undefined;

    if (!row) return "stopped";

    if (row.time_archived !== null) return "stopped";

    if (statusState === "stopped") {
      return this.hasActiveChildActivity(projectInfo, row.directory)
        ? "running"
        : "stopped";
    }

    const age = Date.now() - row.time_updated;
    if (age < OPENCODE_ACTIVE_THRESHOLD_MS) return "running";

    if (this.hasActiveChildActivity(projectInfo, row.directory))
      return "running";

    return "stopped";
  }

  async enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment> {
    const enrichment: SessionEnrichment = {};

    await this.enrichSessionName(projectInfo, enrichment);
    await this.enrichTasks(projectInfo, enrichment);
    await this.enrichMessages(projectInfo, enrichment);

    return enrichment;
  }

  private async enrichSessionName(
    projectInfo: ProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const sessionRow = this.db
        .prepare("SELECT title FROM session WHERE id = ?")
        .get(projectInfo.sessionId) as { title: string } | undefined;
      if (sessionRow?.title) {
        enrichment.sessionName = sessionRow.title;
      }
    } catch {
      log.warn("failed to read session title");
    }
  }

  private async enrichTasks(
    projectInfo: ProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const todos = this.db
        .prepare(
          "SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position",
        )
        .all(projectInfo.sessionId) as {
        content: string;
        status: string;
        priority: string;
        position: number;
      }[];
      if (todos.length > 0) {
        enrichment.tasks = todos.map((t) => ({
          id: String(t.position),
          subject: t.content,
          status: t.status,
          ...(t.status === "in_progress" ? { activeForm: t.content } : {}),
        }));
        enrichment.tasksDone = todos.filter(
          (t) => t.status === "completed",
        ).length;
        enrichment.tasksTotal = todos.length;
      }
    } catch {
      // skip
    }
  }

  private async enrichMessages(
    projectInfo: ProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const msgs = this.db
        .prepare(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 50",
        )
        .all(projectInfo.sessionId) as {
        id: string;
        data: string;
        time_created: number;
      }[];

      const partsByMsg = this.fetchPartsByMessage(msgs.map((m) => m.id));

      for (const msg of msgs) {
        const parsed = parseMessageData(msg.data);
        if (!parsed) continue;

        if (parsed.role === "assistant") {
          extractAssistantEnrichment(msg.id, parsed, partsByMsg, enrichment);
          if (
            enrichment.model &&
            enrichment.inputTokens !== undefined &&
            enrichment.latestAssistantActivity
          )
            break;
        }
      }

      for (const msg of msgs) {
        const parsed = parseMessageData(msg.data);
        if (!parsed) continue;

        if (parsed.role === "user") {
          extractUserActivity(msg.id, partsByMsg, enrichment);
          break;
        }
      }
    } catch {
      // message or part tables don't exist — skip enrichment
    }
  }

  private fetchPartsByMessage(
    msgIds: string[],
  ): Map<string, { data: string }[]> {
    const partsByMsg = new Map<string, { data: string }[]>();
    if (msgIds.length === 0) return partsByMsg;

    const placeholders = msgIds.map(() => "?").join(",");
    const partRows = this.db
      .prepare(
        `SELECT message_id, data FROM part WHERE message_id IN (${placeholders})`,
      )
      .all(...msgIds) as { message_id: string; data: string }[];
    for (const row of partRows) {
      const parts = partsByMsg.get(row.message_id);
      if (parts) {
        parts.push({ data: row.data });
      } else {
        partsByMsg.set(row.message_id, [{ data: row.data }]);
      }
    }
    return partsByMsg;
  }

  private loadStatusLogEvents(): StatusEvent[] | null {
    try {
      const s = statSync(this.statusLogPath);
      if (
        this.lastStatusLogMtime === null ||
        s.mtimeMs !== this.lastStatusLogMtime
      ) {
        let raw: string;
        let slicedMidFile = false;
        if (s.size > STATUS_LOG_TAIL_BYTES) {
          raw = readFileSync(this.statusLogPath, "utf-8").slice(
            -STATUS_LOG_TAIL_BYTES,
          );
          slicedMidFile = true;
        } else {
          raw = readFileSync(this.statusLogPath, "utf-8");
        }
        this.statusLogEvents = parseStatusLines(raw, slicedMidFile);
        this.lastStatusLogMtime = s.mtimeMs;
      }
    } catch {
      this.lastStatusLogMtime = null;
      this.statusLogEvents = null;
      return null;
    }

    return this.statusLogEvents ?? [];
  }

  private resolveStatusLogState(sessionId: string): SessionState | null {
    const matching = this.getStatusLogEventsForSession(sessionId);
    if (matching.length === 0) return null;

    const normalized = matching.map((event) =>
      normalizeOpencodeStatusEvent(event),
    );
    const state = resolveStatusLogState(null, normalized);
    const latest = normalized[normalized.length - 1];

    if (state === "stopped" && latest.event !== "Stop") return null;

    return state;
  }

  private resolveStateFromStatusLog(sessionId: string): StatusEvent | null {
    const matching = this.getStatusLogEventsForSession(sessionId);
    if (matching.length === 0) return null;

    return {
      ...matching[matching.length - 1],
      state:
        this.resolveStatusLogState(sessionId) ??
        matching[matching.length - 1].state,
    };
  }

  private getStatusLogEventsForSession(sessionId: string): StatusEvent[] {
    const events = this.loadStatusLogEvents();
    if (events === null) return [];

    const matching = events.filter((e) => e.session_id === sessionId);
    matching.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return matching;
  }

  private hasActiveChildActivity(
    projectInfo: ProjectInfo,
    directory: string,
  ): boolean {
    return this.getActiveChildActivityRows(projectInfo, directory).length > 0;
  }

  private getActiveChildActivityRows(
    projectInfo: ProjectInfo,
    directory: string,
  ): { id: string; parent_id: string | null; time_updated: number }[] {
    const cutoff = Date.now() - OPENCODE_ACTIVE_THRESHOLD_MS;
    const rows = this.db
      .prepare(
        `SELECT id, parent_id, time_updated FROM session
         WHERE time_archived IS NULL
           AND time_updated > ?
           AND (
             parent_id = ?
             OR (directory = ? AND id != ?)
           )`,
      )
      .all(cutoff, projectInfo.sessionId, directory, projectInfo.sessionId) as {
      id: string;
      parent_id: string | null;
      time_updated: number;
    }[];

    const activeRows: typeof rows = [];

    for (const row of rows) {
      const statusState = this.resolveStatusLogState(row.id);
      if (
        statusState === "stopped" ||
        statusState === "closed" ||
        statusState === "error"
      ) {
        continue;
      }
      if (row.parent_id !== projectInfo.sessionId) {
        log.info("resolveState fallback triggered", {
          project: projectInfo.projectName,
        });
      }
      activeRows.push(row);
    }

    return activeRows;
  }

  async getSubagents(projectInfo: ProjectInfo): Promise<SubagentInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT id, time_created, time_updated FROM session
         WHERE parent_id = ?`,
      )
      .all(projectInfo.sessionId) as {
      id: string;
      time_created: number;
      time_updated: number;
    }[];

    const now = Date.now();
    const activeCutoff = now - SUBAGENT_ACTIVE_THRESHOLD_MS;
    const expiryCutoff = now - SUBAGENT_EXPIRY_MS;

    return rows
      .filter((row) => {
        const isActive = row.time_updated > activeCutoff;
        return isActive || row.time_updated > expiryCutoff;
      })
      .map((row) => {
        let isActive = row.time_updated > activeCutoff;
        if (isActive) {
          const statusEvent = this.resolveStateFromStatusLog(row.id);
          if (
            statusEvent &&
            (statusEvent.state === "stopped" ||
              statusEvent.state === "closed" ||
              statusEvent.state === "error")
          ) {
            isActive = false;
          }
        }
        return {
          agentId: row.id,
          slug: undefined,
          description: undefined,
          isActive,
          lastMessageTime: new Date(row.time_updated).toISOString(),
          launchTime: new Date(row.time_created).toISOString(),
        };
      })
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
  }

  async getNotification(
    _projectInfo: ProjectInfo,
  ): Promise<NotificationMeta | null> {
    return null;
  }

  watchForChanges(onUpdate: () => void): {
    stop: () => void;
  } {
    let stopped = false;
    let statusWatcher: FSWatcher | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const statusLogPath = this.statusLogPath;
    const pollIntervalMs = this.pollIntervalMs;
    const statusPollIntervalMs = this.statusPollIntervalMs;

    function startPolling(interval: number): void {
      pollTimer = setInterval(() => {
        if (stopped) return;
        onUpdate();
      }, interval);
    }

    function startStatusWatcher(): void {
      if (stopped) return;
      const statusDir = dirname(statusLogPath);
      const basenameLog = basename(statusLogPath);
      let lastMtime = statSyncTerse(statusLogPath);
      try {
        statusWatcher = watch(statusDir, (_event, filename) => {
          if (stopped) return;
          if (filename !== null && filename !== basenameLog) return;
          if (filename === null) {
            const mtime = statSyncTerse(statusLogPath);
            if (mtime === null || mtime === lastMtime) return;
            lastMtime = mtime;
          }
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            if (stopped) return;
            if (existsSync(statusLogPath)) {
              onUpdate();
            } else {
              if (statusWatcher) {
                try {
                  statusWatcher.close();
                } catch {
                  // ignore
                }
                statusWatcher = null;
              }
              if (pollTimer) clearInterval(pollTimer);
              startPolling(pollIntervalMs);
            }
          }, DEBOUNCE_MS * 2);
        });
        statusWatcher.on("error", () => {
          if (statusWatcher) {
            try {
              statusWatcher.close();
            } catch {
              // ignore
            }
            statusWatcher = null;
          }
          if (!stopped) {
            if (pollTimer) clearInterval(pollTimer);
            startPolling(pollIntervalMs);
          }
        });
      } catch {
        // directory doesn't exist — polling only
      }
    }

    const fileExists = existsSync(statusLogPath);
    if (fileExists) {
      startStatusWatcher();
      startPolling(statusPollIntervalMs);
    } else {
      startPolling(pollIntervalMs);
    }

    return {
      stop: () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (statusWatcher) {
          try {
            statusWatcher.close();
          } catch {
            // ignore
          }
        }
      },
    };
  }

  projectKey(project: ProjectInfo): string {
    return `opencode::${project.sessionId}`;
  }
}

function normalizeOpencodeStatusEvent(event: StatusEvent): StatusEvent {
  if (
    event.event === "permission.ask" ||
    event.event === "permission.asked" ||
    event.state === "waiting_for_permission"
  ) {
    return {
      ...event,
      event: "PermissionRequest",
      state: "waiting_for_permission",
    };
  }

  if (event.event === "permission.replied") {
    return { ...event, event: "UserPromptSubmit", state: "running" };
  }

  if (event.state === "running") {
    return { ...event, event: "PostToolUse", state: "running" };
  }

  if (event.state === "closed") {
    return { ...event, event: "SessionEnd", state: "closed" };
  }

  if (event.state === "error") {
    return { ...event, event: "StopFailure", state: "error" };
  }

  if (event.state === "stopped") {
    return { ...event, event: "Stop", state: "stopped" };
  }

  return event;
}

/**
 * Fills model, token counts, and assistant activity from a single assistant message.
 * Stops updating fields once they are already populated on the enrichment object.
 */
function extractAssistantEnrichment(
  msgId: string,
  parsed: {
    modelID?: string;
    tokens?: { input?: number; output?: number; cache?: { read?: number } };
  },
  partsByMsg: Map<string, { data: string }[]>,
  enrichment: SessionEnrichment,
): void {
  if (!enrichment.model && typeof parsed.modelID === "string") {
    enrichment.model = parsed.modelID;
  }

  if (enrichment.inputTokens === undefined) {
    const tokens = parsed.tokens;
    if (tokens) {
      const cacheRead = tokens.cache?.read ?? 0;
      const deltaInput = tokens.input ?? 0;
      const deltaOutput = tokens.output ?? 0;
      if (cacheRead > 0 || deltaInput > 0) {
        enrichment.inputTokens = cacheRead + deltaInput;
      }
      if (deltaOutput > 0) {
        enrichment.outputTokens = deltaOutput;
      }
    }
  }

  if (!enrichment.latestAssistantActivity) {
    const parts = partsByMsg.get(msgId) ?? [];
    let text: string | undefined;
    let tool: string | undefined;
    for (const part of parts) {
      const p = parsePartData(part.data);
      if (!p) continue;
      if (p.type === "text") {
        text = p.text;
      } else if (p.type === "tool") {
        tool = p.tool;
      }
      if (text && tool) break;
    }
    if (text !== undefined || tool !== undefined) {
      enrichment.latestAssistantActivity = {
        text: text ? text.slice(0, 200) : undefined,
        tool,
      };
    }
  }
}

/**
 * Fills latestUserActivity from the parts of a single user message.
 * Only updates the enrichment if not already populated.
 */
function extractUserActivity(
  msgId: string,
  partsByMsg: Map<string, { data: string }[]>,
  enrichment: SessionEnrichment,
): void {
  if (enrichment.latestUserActivity) return;

  const parts = partsByMsg.get(msgId) ?? [];
  for (const part of parts) {
    const p = parsePartData(part.data);
    if (!p) continue;
    if (p.type === "text") {
      enrichment.latestUserActivity = {
        text: p.text.slice(0, 200),
        isCommand: false,
      };
      break;
    }
  }
}
