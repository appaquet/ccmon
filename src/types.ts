import type { SessionState } from "./session-core";
import type { SessionEnrichment } from "./session-enrichment";

export type BackendSource = "claude" | "opencode";

export interface ProjectInfo {
  projectDir: string;
  cwd: string;
  projectName: string;
  sessionId: string;
  latestJSONL: string;
  source: BackendSource;
}

export interface SubagentInfo extends SessionEnrichment {
  agentId: string;
  slug?: string;
  description?: string;
  jsonlPath: string;
  isActive: boolean;
  lastMessageTime: string;
  launchTime: string;
}

export interface ProjectState extends ProjectInfo, SessionEnrichment {
  state: SessionState;
  lastUpdated: string | null;
  notificationMessage?: string;
  notificationTimestamp?: string;
  subagents?: SubagentInfo[];
  subagentCount?: number;
}
