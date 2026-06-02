import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  JSONL_ACTIVE_THRESHOLD_MS,
  PERMISSION_RESOLVE_GAP_MS,
  PERMISSION_STALE_MS,
  STATUS_LOG_TAIL_BYTES,
} from "./timing.ts";

export { PERMISSION_RESOLVE_GAP_MS };

export const STATUS_LOG_FILE = "ccmon-status.jsonl";
export const STATUS_FILE_LEGACY = "ccmon-status.json";

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

type ResolutionContext = {
  events: StatusEvent[];
  jsonlMtimeMs: number | null;
  now: number;
};

type ResolutionRule = (ctx: ResolutionContext) => SessionState | null;

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
export function parseStatusLines(
  raw: string,
  slicedMidFile = false,
): StatusEvent[] {
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
    const s = statSync(logPath);
    const size = s.size;
    if (size > STATUS_LOG_TAIL_BYTES) {
      raw = readFileSync(logPath, "utf-8").slice(-STATUS_LOG_TAIL_BYTES);
      slicedMidFile = true;
    } else {
      raw = readFileSync(logPath, "utf-8");
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
    const legacyRaw = readFileSync(legacyPath, "utf-8");
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

function unresolvedPermissionRule(ctx: ResolutionContext): SessionState | null {
  for (let i = ctx.events.length - 1; i >= 0; i--) {
    const e = ctx.events[i];
    if (PERMISSION_RESOLVERS.has(e.event)) break;
    if (e.event === "PermissionRequest") {
      const sid = e.session_id;
      const permTs = new Date(e.timestamp).getTime();
      let resolved = false;
      for (let j = i + 1; j < ctx.events.length; j++) {
        const candidate = ctx.events[j];
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
      const age = ctx.now - new Date(e.timestamp).getTime();
      if (!Number.isNaN(age) && age < PERMISSION_STALE_MS) {
        return "waiting_for_permission";
      }
      break;
    }
  }
  return null;
}

function sessionEndRule(ctx: ResolutionContext): SessionState | null {
  if (ctx.events.length === 0) return null;
  const latest = ctx.events[ctx.events.length - 1];
  if (latest.event === "SessionEnd") return "closed";
  return null;
}

function stopOrActivityRule(ctx: ResolutionContext): SessionState | null {
  if (ctx.events.length === 0) return null;
  const latest = ctx.events[ctx.events.length - 1];
  if (latest.event === "Stop") return "stopped";
  if (latest.event === "PostToolUse" || latest.event === "UserPromptSubmit") {
    const age = ctx.now - new Date(latest.timestamp).getTime();
    if (!Number.isNaN(age) && age < JSONL_ACTIVE_THRESHOLD_MS) {
      return "running";
    }
  }
  return null;
}

function jsonlActivityRule(ctx: ResolutionContext): SessionState | null {
  if (ctx.jsonlMtimeMs === null) return null;
  if (ctx.jsonlMtimeMs <= ctx.now - JSONL_ACTIVE_THRESHOLD_MS) return null;

  if (ctx.events.length > 0) {
    const latest = ctx.events[ctx.events.length - 1];
    if (latest.event === "StopFailure") {
      const age = ctx.now - new Date(latest.timestamp).getTime();
      if (!Number.isNaN(age) && age < JSONL_ACTIVE_THRESHOLD_MS) {
        return null;
      }
    }
  }

  return "running";
}

function stopFailureRule(ctx: ResolutionContext): SessionState | null {
  if (
    ctx.events.length > 0 &&
    ctx.events[ctx.events.length - 1].event === "StopFailure"
  ) {
    return "error";
  }
  return null;
}

const RESOLUTION_RULES: ResolutionRule[] = [
  unresolvedPermissionRule,
  sessionEndRule,
  stopOrActivityRule,
  jsonlActivityRule,
  stopFailureRule,
];

export function resolveState(
  jsonlMtimeMs: number | null,
  rawEvents: StatusEvent[],
): SessionState {
  const events = rawEvents.filter((e) => !NON_STATE_EVENTS.has(e.event));
  const ctx: ResolutionContext = { events, jsonlMtimeMs, now: Date.now() };

  for (const rule of RESOLUTION_RULES) {
    const state = rule(ctx);
    if (state !== null) return state;
  }

  return "stopped";
}
