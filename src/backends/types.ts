import type { SessionState } from "../session-core.ts";
import type {
  NotificationMeta,
  ProjectInfo,
  SessionEnrichment,
  SubagentInfo,
} from "../types.ts";

/**
 * Abstraction over a data source that provides Claude Code / OpenCode
 * session monitoring. Each backend discovers projects, resolves their
 * state, enriches them with model/message/token data, and detects
 * changes via backend-specific mechanisms (fs.watch or polling).
 */
export interface SessionBackend<
  TProjectInfo extends ProjectInfo = ProjectInfo,
> {
  /** Backend source, matching the project variant accepted by this backend. */
  readonly source: TProjectInfo["source"];

  /**
   * Discovers all projects from the data source.
   * Returns basic ProjectInfo (directory, cwd, name, sessionId, etc.).
   */
  scanProjects(): Promise<TProjectInfo[]>;

  /**
   * Starts backend-specific change detection.
   * Calls `onUpdate()` whenever a project's data has changed.
   * Callers should do a full rescan on each notification since the
   * callback provides no parameters guaranteeing completeness.
   * Returns a `{ stop }` handle to tear down.
   */
  watchForChanges(onUpdate: () => void): {
    stop: () => void;
  };

  /**
   * Resolves the session state from backend-specific data.
   * For Claude: reads status event log. For OpenCode: infers from timestamp recency.
   */
  resolveState(projectInfo: TProjectInfo): Promise<SessionState>;

  /**
   * Computes the lastUpdated timestamp for a project.
   * Claude: JSONL mtime. OpenCode: SQL MAX(time_updated).
   */
  computeLastUpdated(projectInfo: TProjectInfo): Promise<string | null>;

  /**
   * Enriches a project with model name, latest messages, token counts,
   * task info, and session name from the data source.
   */
  enrichProject(projectInfo: TProjectInfo): Promise<SessionEnrichment>;

  /**
   * Returns active and recently-completed sub-agents for a session.
   */
  getSubagents(projectInfo: TProjectInfo): Promise<SubagentInfo[]>;

  /**
   * Returns notification metadata for the project, or null if none.
   * Optional — backends without notification support skip this method.
   */
  getNotification?(projectInfo: TProjectInfo): Promise<NotificationMeta | null>;

  /**
   * Stable unique key for a project, suitable for use as a Map key.
   * Must be unique across all backends.
   */
  projectKey(project: TProjectInfo): string;
}

export type AnySessionBackend =
  | (SessionBackend<Extract<ProjectInfo, { source: "claude" }>> & {
      readonly source: "claude";
    })
  | (SessionBackend<Extract<ProjectInfo, { source: "opencode" }>> & {
      readonly source: "opencode";
    });

export const BACKEND_TYPES = ["claude", "opencode"] as const;

/** Discriminated union for backend configuration entries. */
export type BackendConfigEntry =
  | {
      type: "claude";
      enabled: boolean;
      projectsDir?: string;
    }
  | {
      type: "opencode";
      enabled: boolean;
      databasePath?: string;
      pollIntervalMs?: number;
      statusLogPath?: string;
      statusPollIntervalMs?: number;
    };
