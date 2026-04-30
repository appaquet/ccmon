import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type {
  ProjectInfo,
  ProjectState,
  SessionEnrichment,
  SessionState,
  SubagentInfo,
} from "../sessions";
import type { SessionBackend } from "./types";

const OPENCODE_ACTIVE_THRESHOLD_MS = 30_000;
const SUBAGENT_ACTIVE_THRESHOLD_MS = 15_000;
const SUBAGENT_EXPIRY_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export class OpencodeBackend implements SessionBackend {
  private pollIntervalMs: number;

  constructor(
    private db: Database,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.pollIntervalMs = pollIntervalMs;
  }

  async scanProjects(): Promise<ProjectInfo[]> {
    const rows = this.db
      .query(
        `SELECT
           s.id AS sessionId,
           s.directory AS cwd,
           p.name AS projectName,
           s.time_created,
           s.time_updated
         FROM session s
         JOIN project p ON s.project_id = p.id
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

  async buildProjectState(projectInfo: ProjectInfo): Promise<ProjectState> {
    const state = await this.resolveState(projectInfo);

    const row = this.db
      .query(`SELECT time_updated FROM session WHERE id = ?`)
      .get(projectInfo.sessionId) as { time_updated: number } | undefined;

    const lastUpdated = row ? new Date(row.time_updated).toISOString() : null;

    const base: ProjectState = { ...projectInfo, state, lastUpdated };

    const enrichment = await this.enrichProject(projectInfo);
    const subagents = await this.getSubagents(projectInfo);

    const activeCount = subagents.filter((s) => s.isActive).length;

    return {
      ...base,
      ...enrichment,
      subagents: subagents.length > 0 ? subagents : undefined,
      subagentCount: activeCount > 0 ? activeCount : undefined,
    };
  }

  async resolveState(projectInfo: ProjectInfo): Promise<SessionState> {
    const row = this.db
      .query(`SELECT time_updated, time_archived FROM session WHERE id = ?`)
      .get(projectInfo.sessionId) as
      | { time_updated: number; time_archived: number | null }
      | undefined;

    if (!row) return "stopped";

    if (row.time_archived !== null) return "stopped";

    const age = Date.now() - row.time_updated;
    return age < OPENCODE_ACTIVE_THRESHOLD_MS ? "running" : "stopped";
  }

  async enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment> {
    const enrichment: SessionEnrichment = {};

    // Session name from session.title
    try {
      const sessionRow = this.db
        .query("SELECT title FROM session WHERE id = ?")
        .get(projectInfo.sessionId) as { title: string } | undefined;
      if (sessionRow?.title) {
        enrichment.sessionName = sessionRow.title;
      }
    } catch {
      console.warn("Enrich: failed to read session title");
      // skip
    }

    // Tasks from todo table
    try {
      const todos = this.db
        .query(
          "SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position",
        )
        .all(projectInfo.sessionId) as {
        content: string;
        status: string;
        priority: string;
        position: number;
      }[];
      if (todos.length > 0) {
        enrichment.tasks = todos.map((t, _i) => ({
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

    // Messages: role + modelID + tokens are inside the data JSON column
    try {
      const msgs = this.db
        .query(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 50",
        )
        .all(projectInfo.sessionId) as {
        id: string;
        data: string;
        time_created: number;
      }[];

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

        // Tokens — use most recent assistant's cumulative values
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
            if (deltaOutput > 0 || enrichment.outputTokens === undefined) {
              enrichment.outputTokens = deltaOutput;
            }
          }
        }

        // Assistant activity from parts
        if (!enrichment.latestAssistantActivity) {
          const parts = this.db
            .query("SELECT data FROM part WHERE message_id = ?")
            .all(msg.id) as { data: string }[];
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

        const parts = this.db
          .query("SELECT data FROM part WHERE message_id = ?")
          .all(msg.id) as { data: string }[];
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

    return enrichment;
  }

  async getSubagents(projectInfo: ProjectInfo): Promise<SubagentInfo[]> {
    const rows = this.db
      .query(
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
        // Exclude stale sub-agents (not active and older than 30s)
        return isActive || row.time_updated > expiryCutoff;
      })
      .map((row) => ({
        agentId: row.id,
        slug: undefined,
        description: undefined,
        jsonlPath: "",
        isActive: row.time_updated > activeCutoff,
        lastMessageTime: new Date(row.time_updated).toISOString(),
        launchTime: new Date(row.time_created).toISOString(),
      }))
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
  }

  watchForChanges(onUpdate: (maybeProject?: ProjectInfo) => void): {
    stop: () => void;
  } {
    let stopped = false;

    const timer = setInterval(() => {
      if (stopped) return;
      onUpdate();
    }, this.pollIntervalMs);

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  projectKey(project: ProjectInfo): string {
    return `opencode::${project.sessionId}`;
  }
}
