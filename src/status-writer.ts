import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_STATUS_LOG_BYTES } from "./project-utils";
import type { SessionState, StatusEvent } from "./session-core";
import { readStatusLog, resolveState, STATUS_LOG_FILE } from "./session-core";

const STATUS_LOG_TAIL_BYTES = 8 * 1024;

// Prevents concurrent write+trim races on the same status log.
const writeLocks = new Set<string>();

/**
 * Maps a Claude hook event name to the corresponding SessionState.
 * Returns null for events that don't write state (Notification, unrecognized).
 */
export function mapHookEventToState(hookEvent: string): SessionState | null {
  switch (hookEvent) {
    case "UserPromptSubmit":
      return "running";
    case "PostToolUse":
      return "running";
    case "PermissionRequest":
      return "waiting_for_permission";
    case "Stop":
      return "stopped";
    case "StopFailure":
      return "error";
    case "SessionEnd":
      return "closed";
    default:
      return null;
  }
}

/**
 * Handles a Notification hook event by appending a StatusEvent with
 * notificationMessage and notificationTimestamp.
 *
 * For permission_prompt notifications: writes a synthetic PermissionRequest event
 * (insurance for sub-agents where the PermissionRequest hook may not fire) unless
 * the state is already waiting_for_permission, in which case it suppresses the write
 * to avoid duplicate signals.
 */
export async function writeNotificationStatus(
  projectDirPath: string,
  message: string,
  notificationType: string,
  sessionId = "",
  workingDir = "",
): Promise<void> {
  if (notificationType === "permission_prompt") {
    const events = await readStatusLog(projectDirPath);
    const currentState = resolveState(null, events);
    if (currentState === "waiting_for_permission") return;

    const permEvent: StatusEvent = {
      event: "PermissionRequest",
      state: "waiting_for_permission",
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      working_dir: workingDir,
    };
    await writeStatusEvent(projectDirPath, permEvent);
    return;
  }

  const event: StatusEvent = {
    event: "Notification",
    state: "stopped",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    working_dir: workingDir,
    notificationMessage: message,
    notificationTimestamp: new Date().toISOString(),
  };

  await writeStatusEvent(projectDirPath, event);
}

/**
 * Appends a single StatusEvent as an NDJSON line to {projectDirPath}/ccmon-status.jsonl.
 * After appending, trims the file to the last STATUS_LOG_TAIL_BYTES if it exceeds MAX_STATUS_LOG_BYTES.
 */
export async function writeStatusEvent(
  projectDirPath: string,
  event: StatusEvent,
): Promise<void> {
  const logPath = join(projectDirPath, STATUS_LOG_FILE);
  await appendFile(logPath, `${JSON.stringify(event)}\n`);

  if (writeLocks.has(logPath)) return;
  writeLocks.add(logPath);

  try {
    const s = await stat(logPath);
    if (s.size > MAX_STATUS_LOG_BYTES + STATUS_LOG_TAIL_BYTES) {
      let raw = readFileSync(logPath, "utf-8");
      if (raw.length > STATUS_LOG_TAIL_BYTES) {
        raw = raw.slice(-STATUS_LOG_TAIL_BYTES);
      }
      const firstNewline = raw.indexOf("\n");
      const trimmed = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
      writeFileSync(logPath, trimmed, "utf-8");
    }
  } catch {
    // stat or trim failed — not critical, the append already succeeded.
  } finally {
    writeLocks.delete(logPath);
  }
}

/**
 * Overwrites {projectDirPath}/ccmon-status.jsonl with a single StatusEvent line.
 * Used by SessionEnd to reset the log for the next session.
 */
export async function writeStatusTruncate(
  projectDirPath: string,
  event: StatusEvent,
): Promise<void> {
  const logPath = join(projectDirPath, STATUS_LOG_FILE);
  writeFileSync(logPath, `${JSON.stringify(event)}\n`, "utf-8");
}

/**
 * Writes a stopped status to the per-sub-agent ccmon-status.json at agentStatusPath,
 * then appends a SubagentStop event to the session-level log to trigger the file
 * watcher and cause a rescan.
 */
export async function writeSubagentStatus(
  agentStatusPath: string,
  projectDirPath: string,
): Promise<void> {
  writeFileSync(
    agentStatusPath,
    JSON.stringify({ state: "stopped", timestamp: new Date().toISOString() }),
    "utf-8",
  );

  const event: StatusEvent = {
    event: "SubagentStop",
    state: "stopped",
    timestamp: new Date().toISOString(),
    session_id: "",
    working_dir: "",
  };
  await writeStatusEvent(projectDirPath, event);
}
