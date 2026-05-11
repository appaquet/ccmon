export {
  CLOSED_PROJECT_TTL_MS,
  DEFAULT_CLAUDE_DIR,
  disambiguateProjectNames,
  filterStaleProjects,
  MAX_STATUS_LOG_BYTES,
  scanProjects,
} from "./project-utils.ts";
export type { SessionState, StatusEvent } from "./session-core.ts";
export {
  isStatusEvent,
  PERMISSION_RESOLVE_GAP_MS,
  readStatusLog,
  resolveState,
  STATUS_FILE_LEGACY,
  STATUS_LOG_FILE,
} from "./session-core.ts";
export type {
  SessionEnrichment,
  SessionTailCache,
  SessionTailInfo,
  TaskInfo,
} from "./session-enrichment.ts";
export {
  mapHookEventToState,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
  writeSubagentStatus,
} from "./status-writer.ts";
export type {
  BackendSource,
  ProjectInfo,
  ProjectState,
  SubagentInfo,
} from "./types.ts";
