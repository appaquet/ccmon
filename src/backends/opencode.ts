import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  isStatusEvent,
  type SessionState,
  type StatusEvent,
} from "../session-core";
import type { SessionEnrichment } from "../session-enrichment";
import type { ProjectInfo, SubagentInfo } from "../types";
import type { SessionBackend } from "./types";

const OPENCODE_ACTIVE_THRESHOLD_MS = 30_000;
const SUBAGENT_ACTIVE_THRESHOLD_MS = 15_000;
const SUBAGENT_EXPIRY_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 30_000;

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

  constructor(
    private db: DatabaseSync,
    private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private statusLogPath = resolveDefaultStatusLogPath(),
    private statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
  ) {}

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
      projectDir: row.cwd,
      cwd: row.cwd,
      projectName: row.projectName ?? basename(row.cwd),
      sessionId: row.sessionId,
      latestJSONL: "",
      source: "opencode",
    }));
  }

  async computeLastUpdated(projectInfo: ProjectInfo): Promise<string | null> {
    const maxRow = this.db
      .prepare(
        "SELECT MAX(time_updated) AS max_updated FROM session WHERE id = ? OR parent_id = ?",
      )
      .get(projectInfo.sessionId, projectInfo.sessionId) as
      | { max_updated: number | null }
      | undefined;

    return maxRow?.max_updated != null
      ? new Date(maxRow.max_updated).toISOString()
      : null;
  }

  async resolveState(projectInfo: ProjectInfo): Promise<SessionState> {
    const statusEvent = this.resolveStateFromStatusLog(projectInfo.sessionId);

    if (statusEvent) {
      switch (statusEvent.state) {
        case "running":
          return "running";
        case "stopped":
          return "stopped";
        case "waiting_for_permission":
          return "waiting_for_permission";
        case "error":
          return "error";
        case "closed":
          return "closed";
      }
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

    const age = Date.now() - row.time_updated;
    if (age < OPENCODE_ACTIVE_THRESHOLD_MS) return "running";

    const cutoff = Date.now() - OPENCODE_ACTIVE_THRESHOLD_MS;

    // Primary: check for active children via parent_id linkage.
    const activeChild = this.db
      .prepare(
        "SELECT 1 FROM session WHERE parent_id = ? AND time_archived IS NULL AND time_updated > ? LIMIT 1",
      )
      .get(projectInfo.sessionId, cutoff);

    if (activeChild != null) return "running";

    // Fallback: check for any recent non-parent session in the same directory.
    // Catches sub-agents where parent_id linkage may be absent.
    const siblingActive = this.db
      .prepare(
        `SELECT 1 FROM session
         WHERE directory = ?
           AND id != ?
           AND time_archived IS NULL
           AND time_updated > ?
         LIMIT 1`,
      )
      .get(row.directory, projectInfo.sessionId, cutoff);

    if (siblingActive != null) {
      process.stderr.write(
        `ccmon: opencode resolveState fallback triggered for ${projectInfo.projectName} (parent_id check found no active children, but directory scan found activity)\n`,
      );
      return "running";
    }

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
      console.warn("Enrich: failed to read session title");
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

      const msgIds = msgs.map((m) => m.id);
      const partsByMsg = new Map<string, { data: string }[]>();
      if (msgIds.length > 0) {
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
      }

      // Most recent assistant message for model + tokens
      for (const msg of msgs) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.role !== "assistant") continue;

        // Model
        if (!enrichment.model && typeof parsed.modelID === "string") {
          enrichment.model = parsed.modelID;
        }

        // Tokens — use most recent assistant's values.
        if (enrichment.inputTokens === undefined) {
          const tokens = parsed.tokens as Record<string, unknown> | undefined;
          if (tokens) {
            const cacheRead =
              ((tokens.cache as Record<string, unknown> | undefined)
                ?.read as number) ?? 0;
            const deltaInput = (tokens.input as number) ?? 0;
            const deltaOutput = (tokens.output as number) ?? 0;
            if (cacheRead > 0 || deltaInput > 0) {
              enrichment.inputTokens = cacheRead + deltaInput;
            }
            if (deltaOutput > 0) {
              enrichment.outputTokens = deltaOutput;
            }
          }
        }

        // Assistant activity from parts
        if (!enrichment.latestAssistantActivity) {
          const parts = partsByMsg.get(msg.id) ?? [];
          let text: string | undefined;
          let tool: string | undefined;
          for (const part of parts) {
            let p: Record<string, unknown>;
            try {
              p = JSON.parse(part.data) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (p.type === "text" && typeof p.text === "string") {
              text = p.text;
            } else if (p.type === "tool" && typeof p.tool === "string") {
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

        if (
          enrichment.model &&
          enrichment.inputTokens !== undefined &&
          enrichment.latestAssistantActivity
        )
          break;
      }

      // Most recent user message parts
      for (const msg of msgs) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.role !== "user") continue;

        const parts = partsByMsg.get(msg.id) ?? [];
        for (const part of parts) {
          let p: Record<string, unknown>;
          try {
            p = JSON.parse(part.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (p.type === "text" && typeof p.text === "string") {
            enrichment.latestUserActivity = {
              text: (p.text as string).slice(0, 200),
              isCommand: false,
            };
            break;
          }
        }
        break;
      }
    } catch {
      // message or part tables don't exist — skip enrichment
    }
  }

  private resolveStateFromStatusLog(sessionId: string): StatusEvent | null {
    try {
      const s = statSync(this.statusLogPath);
      if (
        this.lastStatusLogMtime === null ||
        s.mtimeMs !== this.lastStatusLogMtime
      ) {
        const raw = readFileSync(this.statusLogPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        const events: StatusEvent[] = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (isStatusEvent(parsed)) {
              events.push(parsed);
            }
          } catch {
            // skip corrupt lines
          }
        }
        this.statusLogEvents = events;
        this.lastStatusLogMtime = s.mtimeMs;
      }
    } catch {
      this.lastStatusLogMtime = null;
      this.statusLogEvents = null;
      return null;
    }

    const matching = (this.statusLogEvents ?? []).filter(
      (e) => e.session_id === sessionId,
    );
    if (matching.length === 0) return null;

    matching.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return matching[matching.length - 1];
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
          jsonlPath: "",
          isActive,
          lastMessageTime: new Date(row.time_updated).toISOString(),
          launchTime: new Date(row.time_created).toISOString(),
        };
      })
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
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
          }, 200);
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
