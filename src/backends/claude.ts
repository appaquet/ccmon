import type { Dirent } from "node:fs";
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  disambiguateProjectNames,
  readProjectInfo,
  scanProjects,
  sessionDirFromJSONL,
} from "../project-utils";
import type { SessionState, StatusEvent } from "../session-core";
import { readStatusLog, resolveState } from "../session-core";
import type {
  SessionEnrichment,
  SessionTailCache,
  SessionTailInfo,
} from "../session-enrichment";
import {
  computeReadRange,
  mergeEnrichment,
  scanEnrichment,
  scanTaskCreateUpdate,
} from "../session-enrichment";
import type { ProjectInfo, ProjectState, SubagentInfo } from "../types";
import { watchForChanges } from "../watcher";
import { buildProjectState as sharedBuildProjectState } from "./build-project-state";
import type { SessionBackend } from "./types";

const JSONL_EXT = ".jsonl";

const SUBAGENT_ACTIVE_THRESHOLD_MS = 15 * 1000;

const SUBAGENT_STOP_GRACE_MS = 5_000;

const SUBAGENT_EXPIRY_MS = 30 * 1000;

export class ClaudeBackend implements SessionBackend {
  sessionTailCache = new Map<string, SessionTailCache>();
  projectStateCache = new Map<string, ProjectState>();

  constructor(private claudeDir: string) {}

  get _claudeDir(): string {
    return this.claudeDir;
  }

  resetCaches(): void {
    this.sessionTailCache.clear();
    this.projectStateCache.clear();
  }

  // ── SessionBackend interface ───────────────────────────────────────────────

  async scanProjects(): Promise<ProjectInfo[]> {
    const projects = await scanProjects(this.claudeDir);
    return projects.map((p) => ({ ...p, source: "claude" }));
  }

  async buildProjectState(projectInfo: ProjectInfo): Promise<ProjectState> {
    const base = await sharedBuildProjectState(this, projectInfo);

    const projectDirPath = join(this.claudeDir, projectInfo.projectDir);
    const events = await readStatusLog(projectDirPath);

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
      notificationMessage,
      notificationTimestamp,
    };
  }

  watchForChanges(onUpdate: () => void): { stop: () => void } {
    return watchForChanges(this.claudeDir, () => {
      onUpdate();
    });
  }

  async resolveState(projectInfo: ProjectInfo): Promise<SessionState> {
    const { state } = await this._fetchStateEvents(projectInfo);
    return state;
  }

  async computeLastUpdated(projectInfo: ProjectInfo): Promise<string | null> {
    try {
      const s = await stat(projectInfo.latestJSONL);
      return new Date(s.mtimeMs).toISOString();
    } catch {
      return null;
    }
  }

  async enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment> {
    const tail = await this.readSessionTail(projectInfo.latestJSONL);
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
    return this.getSubagentInfos(projectInfo.latestJSONL);
  }

  projectKey(project: ProjectInfo): string {
    return join(this.claudeDir, project.projectDir);
  }

  // ── Public helpers (used by tests & watcher path) ──────────────────────────

  async getProjectState(changedProjectDir?: string): Promise<ProjectState[]> {
    if (changedProjectDir !== undefined && this.projectStateCache.size > 0) {
      const dirName = basename(changedProjectDir);
      const info = await readProjectInfo(changedProjectDir, dirName);
      if (info !== null) {
        const updatedState = await this.buildProjectState(info);
        this.projectStateCache.set(changedProjectDir, updatedState);
      } else {
        this.projectStateCache.delete(changedProjectDir);
      }
      const allStates = [...this.projectStateCache.values()];
      for (const s of allStates) {
        s.projectName = basename(s.cwd);
      }
      this._disambiguateProjectNames(allStates);
      for (const s of allStates) {
        this.projectStateCache.set(join(this.claudeDir, s.projectDir), s);
      }
      return allStates;
    }

    const projects = await this.scanProjects();
    if (projects.length === 0) {
      this.projectStateCache.clear();
      return [];
    }

    const states = await Promise.all(
      projects.map((p) => this.buildProjectState(p)),
    );

    this._disambiguateProjectNames(states);

    this.projectStateCache.clear();
    for (let i = 0; i < projects.length; i++) {
      const fullPath = join(this.claudeDir, projects[i].projectDir);
      this.projectStateCache.set(fullPath, states[i]);
    }

    return states;
  }

  readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
    return this._readSessionTail(jsonlPath);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _disambiguateProjectNames(projects: ProjectState[]): void {
    disambiguateProjectNames(projects);
  }

  private async _readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
    let mtimeMs: number;
    let size: number;
    try {
      const s = await stat(jsonlPath);
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {
      return { agentDescriptions: new Map() };
    }

    const cached = this.sessionTailCache.get(jsonlPath);
    const { startOffset, baseData, isDelta } = computeReadRange(
      cached,
      mtimeMs,
      size,
    );

    if (startOffset === -1) {
      if (!cached)
        throw new Error(
          "cache invariant violated: startOffset === -1 but cached is undefined",
        );
      return cached.data;
    }

    let text: string;
    try {
      text = readFileSync(jsonlPath, "utf-8");
      if (startOffset > 0) {
        text = text.slice(startOffset);
      }
    } catch {
      return { agentDescriptions: new Map() };
    }

    const startsAtNewline = text.length > 0 && text[0] === "\n";

    let lines = text.split("\n").filter((l) => l.trim() !== "");

    if (!isDelta && startOffset > 0 && !startsAtNewline && lines.length > 0) {
      lines = lines.slice(1);
    }

    const scannedTasks = scanTaskCreateUpdate(lines, baseData.tasks);
    const scanResult = scanEnrichment(lines, scannedTasks, baseData);
    const merged = mergeEnrichment(scannedTasks, scanResult, baseData);

    this.sessionTailCache.set(jsonlPath, {
      mtime: mtimeMs,
      fileSize: size,
      data: merged,
    });
    return merged;
  }

  private async _fetchStateEvents(projectInfo: ProjectInfo): Promise<{
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

  async getSubagentInfos(
    latestJSONL: string,
    stoppedAtMs: number | null = null,
  ): Promise<SubagentInfo[]> {
    const sessionDir = sessionDirFromJSONL(latestJSONL);
    const subagentsDir = join(sessionDir, "subagents");
    const cutoff = Date.now() - SUBAGENT_ACTIVE_THRESHOLD_MS;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(subagentsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const jsonlEntries = entries.filter((e) => e.name.endsWith(JSONL_EXT));

    const parentTail = await this._readSessionTail(latestJSONL);

    const expiryCutoff = Date.now() - SUBAGENT_EXPIRY_MS;

    const infos = await Promise.all(
      jsonlEntries.map(async (entry): Promise<SubagentInfo | null> => {
        const jsonlPath = join(subagentsDir, entry.name);

        let mtimeMs: number;
        try {
          const s = await stat(jsonlPath);
          mtimeMs = s.mtimeMs;
        } catch {
          return null;
        }

        const nameWithout = entry.name.slice(0, -JSONL_EXT.length);
        const agentId = nameWithout.startsWith("agent-")
          ? nameWithout.slice("agent-".length)
          : nameWithout;

        const stoppedRecently =
          stoppedAtMs !== null &&
          mtimeMs <= stoppedAtMs + SUBAGENT_STOP_GRACE_MS;
        let isActive = !stoppedRecently && mtimeMs > cutoff;

        if (isActive) {
          const agentStatusPath = join(
            subagentsDir,
            `${nameWithout}.ccmon-status.json`,
          );
          try {
            const raw = readFileSync(agentStatusPath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (parsed.state === "stopped") isActive = false;
          } catch {
            // Status file absent or unreadable — fall back to mtime-based detection.
          }
        }

        if (!isActive && mtimeMs < expiryCutoff) return null;

        const enrichment = await this._readSessionTail(jsonlPath);

        let slug: string | undefined;
        let launchTime: string = new Date(mtimeMs).toISOString();
        try {
          const text = readFileSync(jsonlPath, { encoding: "utf-8" }).slice(
            0,
            512,
          );
          const firstLine = text.split("\n")[0];
          if (firstLine) {
            const parsed = JSON.parse(firstLine) as Record<string, unknown>;
            if (typeof parsed.slug === "string") slug = parsed.slug;
            if (typeof parsed.timestamp === "string")
              launchTime = parsed.timestamp;
          }
        } catch {
          // slug and launchTime are both optional — ignore errors
        }

        const lastMessageTime = new Date(mtimeMs).toISOString();
        const description = parentTail.agentDescriptions.get(agentId);
        return {
          agentId,
          slug,
          description,
          jsonlPath,
          isActive,
          lastMessageTime,
          launchTime,
          ...enrichment,
        };
      }),
    );

    return infos
      .filter((info): info is SubagentInfo => info !== null)
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
  }
}
