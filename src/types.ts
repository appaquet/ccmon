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

interface ProjectInfoBase {
  projectDir: string;
  cwd: string;
  projectName: string;
  sessionId: string;
}

export type ProjectInfo =
  | (ProjectInfoBase & { source: "claude"; latestJSONL: string })
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

export interface ProjectState extends SessionEnrichment {
  projectDir: string;
  cwd: string;
  projectName: string;
  sessionId: string;
  source: BackendSource;
  latestJSONL?: string;
  state: SessionState;
  lastUpdated: string | null;
  notificationMessage?: string;
  notificationTimestamp?: string;
  subagents?: SubagentInfo[];
  subagentCount?: number;
}
