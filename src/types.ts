import type { SessionState } from "./session-core.ts";

export type BackendSource = "claude" | "opencode";

export interface TaskInfo {
  id: string;
  subject: string;
  status: string;
  activeForm?: string;
}

export interface SessionEnrichment {
  model?: string;
  latestUserActivity?: { text: string; isCommand: boolean };
  latestAssistantActivity?: { text?: string; tool?: string };
  tasks?: TaskInfo[];
  tasksDone?: number;
  tasksTotal?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionName?: string;
}

/** Fields shared by every backend's project, with backend-agnostic meaning. */
interface ProjectInfoBase {
  cwd: string;
  projectName: string;
  sessionId: string;
}

/**
 * A discovered project, discriminated by its backend `source`. Backend-specific
 * locators live only on the variant that can interpret them: `projectDir` (the
 * encoded directory segment under ~/.claude/projects) and `latestJSONL` are
 * meaningful only with Claude's filesystem layout, so they are claude-only.
 */
export type ProjectInfo =
  | (ProjectInfoBase & {
      source: "claude";
      projectDir: string;
      latestJSONL: string;
    })
  | (ProjectInfoBase & { source: "opencode" });

export interface NotificationMeta {
  notificationMessage: string;
  notificationTimestamp: string;
}

export interface SubagentInfo extends SessionEnrichment {
  agentId: string;
  slug?: string;
  description?: string;
  jsonlPath?: string;
  isActive: boolean;
  lastMessageTime: string;
  launchTime: string;
}

/** Resolved session state and metadata layered on top of a discovered project. */
export interface SessionFields {
  state: SessionState;
  lastUpdated: string | null;
  notificationMessage?: string;
  notificationTimestamp?: string;
  subagents?: SubagentInfo[];
  subagentCount?: number;
}

/**
 * A fully assembled project: its `ProjectInfo` enriched with model/message data
 * and resolved session state. Intersecting the `ProjectInfo` union keeps the
 * `source` discrimination, so `latestJSONL`/`projectDir` are present on claude
 * and absent on opencode by construction — no optional sentinel.
 */
export type ProjectState = ProjectInfo & SessionEnrichment & SessionFields;
