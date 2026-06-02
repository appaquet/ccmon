import { readFileSync, writeFileSync } from "node:fs";
import {
  appendFile,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { SessionState, StatusEvent } from "./session-core.ts";
import {
  readStatusLog,
  resolveState,
  STATUS_LOG_FILE,
} from "./session-core.ts";
import { MAX_STATUS_LOG_BYTES, STATUS_LOG_TAIL_BYTES } from "./timing.ts";

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
 * After appending, trims the file to the last STATUS_LOG_TAIL_BYTES if it exceeds
 * MAX_STATUS_LOG_BYTES. The trim is serialized across OS processes via an exclusive
 * lockfile (O_CREAT|O_EXCL) so that a concurrent append from another `ccmon status`
 * process cannot be lost when the file is rewritten.
 */
export async function writeStatusEvent(
  projectDirPath: string,
  event: StatusEvent,
): Promise<void> {
  const logPath = join(projectDirPath, STATUS_LOG_FILE);
  const lockPath = `${logPath}.lock`;

  const release = await acquireLock(lockPath);
  try {
    await appendFile(logPath, `${JSON.stringify(event)}\n`);
    await trimLogIfNeeded(logPath);
  } finally {
    await release();
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const LOCK_RETRY_INTERVAL_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;

/**
 * Acquires an exclusive cross-process lockfile using O_CREAT|O_EXCL.
 * Retries until the lock is obtained or the timeout elapses.
 * Returns a release function that deletes the lockfile.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      return async () => {
        try {
          await rm(lockPath, { force: true });
        } catch {
          // Lockfile already gone — nothing to do.
        }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `Failed to create lock file ${lockPath}: ${(err as Error).message}`,
        );
      }
      if (Date.now() >= deadline) {
        // Stale lock: the process that created it likely crashed. Remove and retry once.
        try {
          await rm(lockPath, { force: true });
        } catch {
          // Already removed by another process — continue.
        }
        continue;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_INTERVAL_MS),
      );
    }
  }
}

/**
 * Trims the log file to STATUS_LOG_TAIL_BYTES via an atomic temp-file rename
 * when the file size exceeds MAX_STATUS_LOG_BYTES + STATUS_LOG_TAIL_BYTES.
 * Must be called while the caller holds the lockfile for this log path.
 */
async function trimLogIfNeeded(logPath: string): Promise<void> {
  try {
    const s = await stat(logPath);
    if (s.size <= MAX_STATUS_LOG_BYTES + STATUS_LOG_TAIL_BYTES) return;

    let raw = readFileSync(logPath, "utf-8");
    if (raw.length > STATUS_LOG_TAIL_BYTES) {
      raw = raw.slice(-STATUS_LOG_TAIL_BYTES);
    }
    const firstNewline = raw.indexOf("\n");
    const trimmed = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;

    const tmpPath = `${logPath}.tmp`;
    await writeFile(tmpPath, trimmed, "utf-8");
    await rename(tmpPath, logPath);
  } catch {
    // stat or trim failed — not critical, the append already succeeded.
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
