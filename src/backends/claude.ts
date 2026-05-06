import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readStatusLog, resolveState } from "../session-core";
import type {
  ProjectInfo,
  ProjectState,
  SessionEnrichment,
  SessionState,
  StatusEvent,
  SubagentInfo,
} from "../sessions";
import { SessionStore } from "../sessions";
import { watchForChanges } from "../watcher";
import type { SessionBackend } from "./types";

/**
 * Wraps existing Claude Code file-system monitoring logic behind
 * the SessionBackend interface. Uses a SessionStore instance for
 * cache-dependent operations, giving each backend its own cache scope.
 */
export class ClaudeBackend implements SessionBackend {
  private store: SessionStore;

  constructor(
    private claudeDir: string,
    store?: SessionStore,
  ) {
    this.store = store ?? new SessionStore(claudeDir);
  }

  async scanProjects(): Promise<ProjectInfo[]> {
    const projects = await this.store.scanProjects();
    return projects.map((p) => ({ ...p, source: "claude" }));
  }

  async buildProjectState(projectInfo: ProjectInfo): Promise<ProjectState> {
    return this.store.buildProjectState(projectInfo);
  }

  watchForChanges(onUpdate: () => void): { stop: () => void } {
    return watchForChanges(this.claudeDir, () => {
      onUpdate();
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
      const s = await stat(projectInfo.latestJSONL);
      jsonlMtimeMs = s.mtimeMs;
    } catch {
      // JSONL disappeared — leave null
    }

    const state = resolveState(jsonlMtimeMs, events);
    return { state, events, jsonlMtimeMs };
  }

  /**
   * Secondary convenience method for enrichment-only access.
   * buildProjectState() is the primary path; use this when you only need
   * enrichment data without state resolution or sub-agent info.
   */
  async enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment> {
    const tail = await this.store.readSessionTail(projectInfo.latestJSONL);
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

  /**
   * Returns sub-agents for the session identified by latestJSONL.
   *
   * Does NOT apply SUBAGENT_STOP_GRACE_MS (the grace period after session stop).
   * Callers needing accurate stopped sub-agent detection should use
   * buildProjectState(), which computes stoppedAtMs from the status log and
   * passes it to getSubagentInfos internally.
   */
  async getSubagents(projectInfo: ProjectInfo): Promise<SubagentInfo[]> {
    return this.store.getSubagentInfos(projectInfo.latestJSONL);
  }

  projectKey(project: ProjectInfo): string {
    return join(this.claudeDir, project.projectDir);
  }
}
