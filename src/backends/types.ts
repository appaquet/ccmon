import type {
  ProjectInfo,
  ProjectState,
  SessionEnrichment,
  SessionState,
  SubagentInfo,
} from "../sessions";

/**
 * Abstraction over a data source that provides Claude Code / OpenCode
 * session monitoring. Each backend discovers projects, resolves their
 * state, enriches them with model/message/token data, and detects
 * changes via backend-specific mechanisms (fs.watch or polling).
 */
export interface SessionBackend {
  /**
   * Discovers all projects from the data source.
   * Returns basic ProjectInfo (directory, cwd, name, sessionId, etc.).
   */
  scanProjects(): Promise<ProjectInfo[]>;

  /**
   * Full project state: discovery + state resolution + enrichment + sub-agents.
   * This is the primary entry point for the server and CLI.
   */
  buildProjectState(projectInfo: ProjectInfo): Promise<ProjectState>;

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
  resolveState(projectInfo: ProjectInfo): Promise<SessionState>;

  /**
   * Enriches a project with model name, latest messages, token counts,
   * task info, and session name from the data source.
   */
  enrichProject(projectInfo: ProjectInfo): Promise<SessionEnrichment>;

  /**
   * Returns active and recently-completed sub-agents for a session.
   */
  getSubagents(projectInfo: ProjectInfo): Promise<SubagentInfo[]>;

  /**
   * Stable unique key for a project, suitable for use as a Map key.
   * Must be unique across all backends.
   */
  projectKey(project: ProjectInfo): string;
}

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
