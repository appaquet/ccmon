import { join } from "node:path";

// Staleness window for waiting_for_permission signals.
const PERMISSION_STALE_MS = 5 * 60 * 1000;

// Minimum time after a PermissionRequest before a same-session PostToolUse can resolve it.
// Guards against concurrent sub-agents that share the same session_id arriving within this window.
export const PERMISSION_RESOLVE_GAP_MS = 3000;

// JSONL mtime threshold: files written within this window indicate active session.
// Claude writes continuously during turns so 60s covers any lag.
const JSONL_ACTIVE_THRESHOLD_MS = 60_000;

export const STATUS_LOG_FILE = "ccmon-status.jsonl";
export const STATUS_FILE_LEGACY = "ccmon-status.json";

// Bytes to keep when trimming the status log after it exceeds MAX_STATUS_LOG_BYTES.
const STATUS_LOG_TAIL_BYTES = 8 * 1024;

const VALID_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting_for_permission",
  "stopped",
  "closed",
  "error",
]);

const NON_STATE_EVENTS = new Set(["Notification", "SubagentStop"]);

const PERMISSION_RESOLVERS = new Set([
  "Stop",
  "StopFailure",
  "SessionEnd",
  "UserPromptSubmit",
]);

export type SessionState =
  | "running"
  | "waiting_for_permission"
  | "stopped"
  | "closed"
  | "error";

export interface StatusEvent {
  event: string;
  state: SessionState;
  timestamp: string; // ISO 8601
  session_id: string;
  working_dir: string;
  notificationMessage?: string;
  notificationTimestamp?: string;
}

// Legacy single-object format for migration from ccmon-status.json.
interface StatusFileLegacy {
  state: SessionState;
  timestamp: string;
  session_id: string;
  working_dir: string;
  notificationMessage?: string;
  notificationTimestamp?: string;
}

export function isStatusEvent(v: unknown): v is StatusEvent {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.event === "string" &&
    typeof obj.state === "string" &&
    VALID_STATES.has(obj.state) &&
    typeof obj.timestamp === "string" &&
    typeof obj.session_id === "string" &&
    typeof obj.working_dir === "string"
  );
}

function isStatusFileLegacy(v: unknown): v is StatusFileLegacy {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.state === "string" &&
    VALID_STATES.has(obj.state) &&
    typeof obj.timestamp === "string" &&
    typeof obj.session_id === "string" &&
    typeof obj.working_dir === "string"
  );
}

/**
 * Parses NDJSON lines into StatusEvent[], skipping corrupt lines.
 * When slicedMidFile is true, the first line is discarded (may be partial).
 */
function parseStatusLines(raw: string, slicedMidFile: boolean): StatusEvent[] {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const startIdx = slicedMidFile && lines.length > 0 ? 1 : 0;
  const events: StatusEvent[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (isStatusEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Skip corrupt lines.
    }
  }
  return events;
}

export async function readStatusLog(
  projectDir: string,
): Promise<StatusEvent[]> {
  const logPath = join(projectDir, STATUS_LOG_FILE);

  let raw: string | null = null;
  let slicedMidFile = false;
  try {
    const file = Bun.file(logPath);
    const size = file.size;
    if (size > STATUS_LOG_TAIL_BYTES) {
      raw = await file.slice(-STATUS_LOG_TAIL_BYTES).text();
      slicedMidFile = true;
    } else {
      raw = await file.text();
    }
  } catch {
    // .jsonl absent — try legacy .json fallback
  }

  if (raw !== null) {
    return parseStatusLines(raw, slicedMidFile);
  }

  // Migration fallback: read legacy ccmon-status.json and convert.
  const legacyPath = join(projectDir, STATUS_FILE_LEGACY);
  try {
    const legacyRaw = await Bun.file(legacyPath).text();
    const parsed = JSON.parse(legacyRaw);
    if (isStatusFileLegacy(parsed)) {
      const event: StatusEvent = {
        event: "Stop",
        state: parsed.state,
        timestamp: parsed.timestamp,
        session_id: parsed.session_id,
        working_dir: parsed.working_dir,
      };
      if (parsed.notificationMessage !== undefined) {
        event.notificationMessage = parsed.notificationMessage;
      }
      if (parsed.notificationTimestamp !== undefined) {
        event.notificationTimestamp = parsed.notificationTimestamp;
      }
      return [event];
    }
  } catch {
    // Legacy file absent or corrupt — return empty.
  }

  return [];
}

export function resolveState(
  jsonlMtimeMs: number | null,
  events: StatusEvent[],
): SessionState {
  // Filter to state-bearing events only.
  const stateful = events.filter((e) => !NON_STATE_EVENTS.has(e.event));

  // Priority 1: scan backward for unresolved PermissionRequest.
  for (let i = stateful.length - 1; i >= 0; i--) {
    const e = stateful[i];
    if (PERMISSION_RESOLVERS.has(e.event)) break;
    if (e.event === "PermissionRequest") {
      // Forward-scan from this position for a same-session PostToolUse.
      const sid = e.session_id;
      const permTs = new Date(e.timestamp).getTime();
      let resolved = false;
      for (let j = i + 1; j < stateful.length; j++) {
        const candidate = stateful[j];
        if (candidate.session_id === sid && candidate.event === "PostToolUse") {
          const candidateTs = new Date(candidate.timestamp).getTime();
          if (
            !Number.isNaN(permTs) &&
            !Number.isNaN(candidateTs) &&
            candidateTs >= permTs + PERMISSION_RESOLVE_GAP_MS
          ) {
            resolved = true;
            break;
          }
        }
      }
      if (resolved) break;

      const age = Date.now() - new Date(e.timestamp).getTime();
      if (!Number.isNaN(age) && age < PERMISSION_STALE_MS) {
        return "waiting_for_permission";
      }
      break;
    }
  }

  // Priority 2 & 3: check latest state-bearing event.
  if (stateful.length > 0) {
    const latest = stateful[stateful.length - 1];
    if (latest.event === "SessionEnd") {
      return "closed";
    }
    if (latest.event === "Stop") {
      return "stopped";
    }
    if (latest.event === "PostToolUse" || latest.event === "UserPromptSubmit") {
      const age = Date.now() - new Date(latest.timestamp).getTime();
      if (!Number.isNaN(age) && age < JSONL_ACTIVE_THRESHOLD_MS) {
        return "running";
      }
    }
  }

  // Priority 4: JSONL mtime fallback.
  if (
    jsonlMtimeMs !== null &&
    jsonlMtimeMs > Date.now() - JSONL_ACTIVE_THRESHOLD_MS
  ) {
    return "running";
  }

  // Priority 4.5: StopFailure → error (after JSONL mtime so a resumed session overrides it).
  if (
    stateful.length > 0 &&
    stateful[stateful.length - 1].event === "StopFailure"
  ) {
    return "error";
  }

  // Priority 5: default.
  return "stopped";
}
