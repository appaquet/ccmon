import { basename, join } from "node:path";
import { readStatusLog, resolveState } from "../session-core";
import type {
  ProjectInfo,
  ProjectState,
  SessionEnrichment,
  SessionState,
  StatusEvent,
  SubagentInfo,
} from "../sessions";
import { getSubagentInfos, readSessionTail, scanProjects } from "../sessions";
import { watchForChanges } from "../watcher";
import type { SessionBackend } from "./types";

/**
 * Wraps existing Claude Code file-system monitoring logic behind
 * the SessionBackend interface. Thin delegation layer — no behavior change.
 */
export class ClaudeBackend implements SessionBackend {
  constructor(private claudeDir: string) {}

  async scanProjects(): Promise<ProjectInfo[]> {
    const projects = await scanProjects(this.claudeDir);
    return projects.map((p) => ({ ...p, source: "claude" }));
  }

  async buildProjectState(projectInfo: ProjectInfo): Promise<ProjectState> {
    const { state, events, jsonlMtimeMs } =
      await this.fetchStateEvents(projectInfo);

    const latestEventTs =
      events.length > 0 ? events[events.length - 1].timestamp : null;
    const lastUpdated: string | null =
      jsonlMtimeMs !== null
        ? new Date(jsonlMtimeMs).toISOString()
        : latestEventTs;

    const base: ProjectState = {
      ...projectInfo,
      source: "claude",
      state,
      lastUpdated,
    };

    const tail = await readSessionTail(projectInfo.latestJSONL);

    // Find stoppedAtMs from latest Stop/SessionEnd event
    let stoppedAtMs: number | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "Stop" || e.event === "SessionEnd") {
        stoppedAtMs = new Date(e.timestamp).getTime();
        break;
      }
    }

    const subagents =
      state === "running" || state === "waiting_for_permission"
        ? await getSubagentInfos(projectInfo.latestJSONL, stoppedAtMs)
        : [];
    const subagentCount = subagents.filter((s) => s.isActive).length;

    // Extract notification fields from latest event
    let notificationMessage: string | undefined;
    let notificationTimestamp: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.notificationMessage !== undefined) {
        notificationMessage = e.notificationMessage;
        notificationTimestamp = e.notificationTimestamp;
        break;
      }
    }

    return {
      ...base,
      latestUserActivity: tail.latestUserActivity,
      latestAssistantActivity: tail.latestAssistantActivity,
      model: tail.model,
      sessionName: tail.sessionName,
      tasks: tail.tasks,
      tasksDone: tail.tasksDone,
      tasksTotal: tail.tasksTotal,
      inputTokens: tail.inputTokens,
      outputTokens: tail.outputTokens,
      notificationMessage,
      notificationTimestamp,
      subagents: subagents.length > 0 ? subagents : undefined,
      subagentCount: subagentCount > 0 ? subagentCount : undefined,
    };
  }

  watchForChanges(onUpdate: (maybeProject?: ProjectInfo) => void): {
    stop: () => void;
  } {
    return watchForChanges(this.claudeDir, (projectDir: string) => {
      const info: ProjectInfo = {
        projectDir: basename(projectDir),
        cwd: "",
        projectName: basename(projectDir),
        sessionId: "",
        latestJSONL: "",
        source: "claude",
      };
      onUpdate(info);
    });
  }

  async resolveState(projectInfo: ProjectInfo): Promise<SessionState> {
    const { state } = await this.fetchStateEvents(projectInfo);
    return state;
  }

  private async fetchStateEvents(projectInfo: ProjectInfo): Promise<{
    state: SessionState;
    events: StatusEvent[];
    jsonlMtimeMs: number | null;
  }> {
    const projectDirPath = join(this.claudeDir, projectInfo.projectDir);
    const events = await readStatusLog(projectDirPath);

    let jsonlMtimeMs: number | null = null;
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(projectInfo.latestJSONL);
      jsonlMtimeMs = s.mtimeMs;
    } catch {
      // JSONL disappeared — leave null
    }

    const state = resolveState(jsonlMtimeMs, events);
    return { state, events, jsonlMtimeMs };
  }

  async enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment> {
    const tail = await readSessionTail(projectInfo.latestJSONL);
    return {
      model: tail.model,
      latestUserActivity: tail.latestUserActivity,
      latestAssistantActivity: tail.latestAssistantActivity,
      tasks: tail.tasks,
      tasksDone: tail.tasksDone,
      tasksTotal: tail.tasksTotal,
      inputTokens: tail.inputTokens,
      outputTokens: tail.outputTokens,
      sessionName: tail.sessionName,
    };
  }

  async getSubagents(projectInfo: ProjectInfo): Promise<SubagentInfo[]> {
    return getSubagentInfos(projectInfo.latestJSONL);
  }

  projectKey(project: ProjectInfo): string {
    return join(this.claudeDir, project.projectDir);
  }
}
