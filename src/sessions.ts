import type { Dirent } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionState, StatusEvent } from "./session-core";
import {
  isStatusEvent,
  PERMISSION_RESOLVE_GAP_MS,
  readStatusLog,
  resolveState,
  STATUS_FILE_LEGACY,
  STATUS_LOG_FILE,
} from "./session-core";
import {
  computeReadRange,
  mergeEnrichment,
  type SessionEnrichment,
  type SessionTailCache,
  type SessionTailInfo,
  scanEnrichment,
  scanTaskCreateUpdate,
} from "./session-enrichment";

export type { SessionState, StatusEvent };
export {
  isStatusEvent,
  PERMISSION_RESOLVE_GAP_MS,
  readStatusLog,
  resolveState,
  STATUS_FILE_LEGACY,
  STATUS_LOG_FILE,
};

export type {
  SessionEnrichment,
  SessionTailCache,
  SessionTailInfo,
  TaskInfo,
} from "./session-enrichment";

export type BackendSource = "claude" | "opencode";

const JSONL_EXT = ".jsonl";
export const MAX_STATUS_LOG_BYTES = 64 * 1024;
const STATUS_LOG_TAIL_BYTES = 8 * 1024;

// Sub-agents write continuously while active; 15s covers any lag without
// counting finished agents as still running.
const SUBAGENT_ACTIVE_THRESHOLD_MS = 15 * 1000;

// Grace period for sub-agent stopped detection: JSONL mtime slightly newer
// than the stopped timestamp is expected (Claude writes a system entry after Stop).
const SUBAGENT_STOP_GRACE_MS = 5_000;

// Completed sub-agents are excluded from the payload after this duration
// to keep the state map lean.
const SUBAGENT_EXPIRY_MS = 30 * 1000;

// Closed projects (SessionEnd) are removed from the dashboard after this window.
export const CLOSED_PROJECT_TTL_MS = 60_000;

export const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude", "projects");

export function disambiguateProjectNames(projects: ProjectState[]): void {
  const groups = new Map<string, ProjectState[]>();
  for (const p of projects) {
    const existing = groups.get(p.projectName);
    if (existing !== undefined) {
      existing.push(p);
    } else {
      groups.set(p.projectName, [p]);
    }
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;

    const maxParts = Math.max(...group.map((p) => p.cwd.split("/").length));
    let segments = 2;
    while (segments <= maxParts) {
      const seen = new Set<string>();
      let hasDuplicates = false;
      for (const p of group) {
        const parts = p.cwd.split("/");
        const name = parts.slice(-segments).join("/");
        if (seen.has(name)) {
          hasDuplicates = true;
          break;
        }
        seen.add(name);
      }
      if (!hasDuplicates) break;
      segments++;
    }

    if (segments <= maxParts) {
      for (const p of group) {
        const parts = p.cwd.split("/");
        p.projectName = parts.slice(-segments).join("/");
      }
    }
  }
}

export async function scanProjects(
  claudeDir: string = DEFAULT_CLAUDE_DIR,
): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(claudeDir);
  } catch {
    return [];
  }

  const results: ProjectInfo[] = [];

  for (const entry of entries) {
    if (entry === "subagents") continue;

    const fullPath = join(claudeDir, entry);
    const info = await readProjectInfo(fullPath, entry);
    if (info !== null) {
      results.push(info);
    }
  }

  return results;
}

export class SessionStore {
  sessionTailCache = new Map<string, SessionTailCache>();
  projectStateCache = new Map<string, ProjectState>();
  private _claudeDir: string;

  constructor(claudeDir: string) {
    this._claudeDir = claudeDir;
  }

  get claudeDir(): string {
    return this._claudeDir;
  }

  resetCaches(): void {
    this.sessionTailCache.clear();
    this.projectStateCache.clear();
  }

  /**
   * Scans this.claudeDir for Claude Code project subdirectories and returns metadata
   * parsed from the most recent JSONL session file in each.
   */
  async scanProjects(): Promise<ProjectInfo[]> {
    return scanProjects(this.claudeDir);
  }

  /**
   * Reads a JSONL session file and extracts enrichment fields by scanning lines
   * from newest to oldest. On first read the entire file is parsed (up to 10 MB);
   * subsequent reads only parse bytes appended since the last read (delta mode).
   * If the file shrinks the cache is reset and the full file is re-read.
   */
  async readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
    let mtimeMs: number;
    let size: number;
    try {
      const s = await stat(jsonlPath);
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {
      return { agentDescriptions: new Map() };
    }

    const cached = this.sessionTailCache.get(jsonlPath);
    const { startOffset, baseData, isDelta } = computeReadRange(
      cached,
      mtimeMs,
      size,
    );

    if (startOffset === -1) {
      // Cache hit: nothing changed. cached is guaranteed non-null when startOffset === -1
      // (computeReadRange only returns -1 when cached !== undefined).
      if (!cached)
        throw new Error(
          "cache invariant violated: startOffset === -1 but cached is undefined",
        );
      return cached.data;
    }

    let text: string;
    try {
      text = readFileSync(jsonlPath, "utf-8");
      if (startOffset > 0) {
        text = text.slice(startOffset);
      }
    } catch {
      return { agentDescriptions: new Map() };
    }

    // Whether startOffset falls exactly on a newline byte (clean boundary).
    // When true, no partial-line discard is needed even in cap-based reads.
    const startsAtNewline = text.length > 0 && text[0] === "\n";

    let lines = text.split("\n").filter((l) => l.trim() !== "");

    // Discard the first element when starting at a cap-based offset that landed
    // mid-line (may be a partial record). Skip the discard when the offset falls
    // exactly on a newline byte — in that case the empty first element was already
    // removed by the filter above and the next element is a complete line.
    if (!isDelta && startOffset > 0 && !startsAtNewline && lines.length > 0) {
      lines = lines.slice(1);
    }

    const scannedTasks = scanTaskCreateUpdate(lines, baseData.tasks);
    const scanResult = scanEnrichment(lines, scannedTasks, baseData);
    const merged = mergeEnrichment(scannedTasks, scanResult, baseData);

    this.sessionTailCache.set(jsonlPath, {
      mtime: mtimeMs,
      fileSize: size,
      data: merged,
    });
    return merged;
  }

  /**
   * Returns the aggregated state for every discovered Claude Code project.
   * Combines scan, status file, staleness check, and liveness detection.
   *
   * If changedProjectDir (full path) is provided and the cache is populated,
   * only that project is rescanned and merged into the cached state, avoiding
   * a full I/O sweep of all projects on every watcher event.
   */
  async getProjectState(changedProjectDir?: string): Promise<ProjectState[]> {
    // Targeted refresh: only rescan the changed project when the cache is warm.
    if (changedProjectDir !== undefined && this.projectStateCache.size > 0) {
      const dirName = basename(changedProjectDir);
      const info = await readProjectInfo(changedProjectDir, dirName);
      if (info !== null) {
        const updatedState = await this.buildProjectState(info);
        this.projectStateCache.set(changedProjectDir, updatedState);
      } else {
        // Project disappeared — remove from cache.
        this.projectStateCache.delete(changedProjectDir);
      }
      // Reset to basename before re-disambiguating so stale expanded names don't
      // persist when projects are added/removed.
      const allStates = [...this.projectStateCache.values()];
      for (const s of allStates) {
        s.projectName = basename(s.cwd);
      }
      this.disambiguateProjectNames(allStates);
      for (const s of allStates) {
        this.projectStateCache.set(join(this.claudeDir, s.projectDir), s);
      }
      return allStates;
    }

    // Full scan: populate the cache.
    const projects = await this.scanProjects();
    if (projects.length === 0) {
      this.projectStateCache.clear();
      return [];
    }

    const states = await Promise.all(
      projects.map((p) => this.buildProjectState(p)),
    );

    this.disambiguateProjectNames(states);

    this.projectStateCache.clear();
    for (let i = 0; i < projects.length; i++) {
      const fullPath = join(this.claudeDir, projects[i].projectDir);
      this.projectStateCache.set(fullPath, states[i]);
    }

    return states;
  }

  /**
   * Expands projectName for projects that share the same basename by prepending
   * parent path segments from cwd until all names within each collision group are
   * unique. Projects with already-unique basenames are left unchanged.
   * Mutates the array in place.
   *
   * Callers filtering by projectName should also match against basename(cwd) to
   * handle the case where a name was expanded (e.g. --project foo should still find
   * a project named "parent/foo").
   */
  disambiguateProjectNames(projects: ProjectState[]): void {
    disambiguateProjectNames(projects);
  }

  async buildProjectState(project: ProjectInfo): Promise<ProjectState> {
    const projectDirPath = join(this.claudeDir, project.projectDir);
    const events = await readStatusLog(projectDirPath);

    // Stat the JSONL once: provides both the mtime for state resolution and the
    // lastUpdated fallback without a redundant second stat call.
    let jsonlMtimeMs: number | null = null;
    try {
      const s = await stat(project.latestJSONL);
      jsonlMtimeMs = s.mtimeMs;
    } catch {
      // JSONL disappeared or unreadable — leave null
    }

    const state = resolveState(jsonlMtimeMs, events);

    // JSONL mtime is the authoritative recency signal; status event timestamps only
    // used as fallback when no JSONL mtime is available.
    const latestEventTs =
      events.length > 0 ? events[events.length - 1].timestamp : null;
    const lastUpdated: string | null =
      jsonlMtimeMs !== null
        ? new Date(jsonlMtimeMs).toISOString()
        : latestEventTs;

    const base: ProjectState = { ...project, state, lastUpdated };

    // Fetch enrichment for all states so stopped sessions still show messages/tokens/tasks.
    // Sub-agents are only relevant for active sessions.
    const tail = await this.readSessionTail(project.latestJSONL);

    // Extract stoppedAtMs from latest Stop/SessionEnd event.
    let stoppedAtMs: number | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "Stop" || e.event === "SessionEnd") {
        stoppedAtMs = new Date(e.timestamp).getTime();
        break;
      }
    }

    const subagents =
      state === "running" || state === "waiting_for_permission"
        ? await this.getSubagentInfos(project.latestJSONL, stoppedAtMs)
        : [];
    const subagentCount = subagents.filter((s) => s.isActive).length;

    // Extract notification fields from latest event that has notificationMessage.
    let notificationMessage: string | undefined;
    let notificationTimestamp: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.notificationMessage !== undefined) {
        notificationMessage = e.notificationMessage;
        notificationTimestamp = e.notificationTimestamp;
        break;
      }
    }

    return {
      ...base,
      latestUserActivity: tail.latestUserActivity,
      latestAssistantActivity: tail.latestAssistantActivity,
      model: tail.model,
      sessionName: tail.sessionName,
      tasksDone: tail.tasksDone,
      tasksTotal: tail.tasksTotal,
      inputTokens: tail.inputTokens,
      outputTokens: tail.outputTokens,
      notificationMessage,
      notificationTimestamp,
      subagents: subagents.length > 0 ? subagents : undefined,
      subagentCount: subagentCount > 0 ? subagentCount : undefined,
    };
  }

  /**
   * Returns SubagentInfo for every sub-agent JSONL found in {sessionDir}/subagents/.
   * Each entry includes enrichment data from readSessionTail plus identity fields
   * (agentId, jsonlPath, isActive, optional slug). Returns [] if the dir is absent.
   */
  async getSubagentInfos(
    latestJSONL: string,
    stoppedAtMs: number | null = null,
  ): Promise<SubagentInfo[]> {
    const sessionDir = sessionDirFromJSONL(latestJSONL);
    const subagentsDir = join(sessionDir, "subagents");
    const cutoff = Date.now() - SUBAGENT_ACTIVE_THRESHOLD_MS;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(subagentsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const jsonlEntries = entries.filter((e) => e.name.endsWith(JSONL_EXT));

    // Read parent session tail once to get the agentDescriptions map; zero extra I/O
    // since readSessionTail caches by path and is called again in buildProjectState
    // in the same event-loop turn.
    const parentTail = await this.readSessionTail(latestJSONL);

    const expiryCutoff = Date.now() - SUBAGENT_EXPIRY_MS;

    const infos = await Promise.all(
      jsonlEntries.map(async (entry): Promise<SubagentInfo | null> => {
        const jsonlPath = join(subagentsDir, entry.name);

        let mtimeMs: number;
        try {
          const s = await stat(jsonlPath);
          mtimeMs = s.mtimeMs;
        } catch {
          return null;
        }

        // Extract agentId from filename: "agent-ae89d86.jsonl" → "ae89d86"
        const nameWithout = entry.name.slice(0, -JSONL_EXT.length);
        const agentId = nameWithout.startsWith("agent-")
          ? nameWithout.slice("agent-".length)
          : nameWithout;

        const stoppedRecently =
          stoppedAtMs !== null &&
          mtimeMs <= stoppedAtMs + SUBAGENT_STOP_GRACE_MS;
        let isActive = !stoppedRecently && mtimeMs > cutoff;

        // A per-agent ccmon-status.json with state "stopped" overrides mtime-based detection.
        if (isActive) {
          const agentStatusPath = join(
            subagentsDir,
            `${nameWithout}.ccmon-status.json`,
          );
          try {
            const raw = readFileSync(agentStatusPath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (parsed.state === "stopped") isActive = false;
          } catch {
            // Status file absent or unreadable — fall back to mtime-based detection.
          }
        }

        // Exclude completed agents older than 30 seconds to keep payload lean.
        if (!isActive && mtimeMs < expiryCutoff) return null;

        const enrichment = await this.readSessionTail(jsonlPath);

        // Read slug and launch timestamp from first line (best-effort).
        // launchTime uses the recorded first-entry timestamp rather than mtime so that
        // a long-running agent that finishes last doesn't sort ahead of a later-launched one.
        let slug: string | undefined;
        let launchTime: string = new Date(mtimeMs).toISOString(); // mtime fallback
        try {
          const text = readFileSync(jsonlPath, { encoding: "utf-8" }).slice(
            0,
            512,
          );
          const firstLine = text.split("\n")[0];
          if (firstLine) {
            const parsed = JSON.parse(firstLine) as Record<string, unknown>;
            if (typeof parsed.slug === "string") slug = parsed.slug;
            if (typeof parsed.timestamp === "string")
              launchTime = parsed.timestamp;
          }
        } catch {
          // slug and launchTime are both optional — ignore errors
        }

        const lastMessageTime = new Date(mtimeMs).toISOString();
        const description = parentTail.agentDescriptions.get(agentId);
        return {
          agentId,
          slug,
          description,
          jsonlPath,
          isActive,
          lastMessageTime,
          launchTime,
          ...enrichment,
        };
      }),
    );

    return infos
      .filter((info): info is SubagentInfo => info !== null)
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
  }
}

/**
 * Sub-agent enrichment: enrichment fields plus identity and activity metadata
 * derived from the sub-agent's JSONL file.
 */
export interface SubagentInfo extends SessionEnrichment {
  agentId: string; // extracted from filename: agent-{agentId}.jsonl
  slug?: string; // from first line of sub-agent JSONL
  description?: string; // from parent session queue-operation enqueue entry
  jsonlPath: string; // absolute path to sub-agent JSONL
  isActive: boolean; // mtime within last 15 seconds
  lastMessageTime: string; // ISO 8601 from file mtime
  launchTime: string; // ISO 8601 from first JSONL entry timestamp, falls back to file mtime
}

export interface ProjectInfo {
  projectDir: string; // directory name under ~/.claude/projects/
  cwd: string; // working directory (from JSONL first line)
  projectName: string; // last segment of cwd
  sessionId: string; // from JSONL first line
  latestJSONL: string; // absolute path to most recent .jsonl file
  source: BackendSource; // backend identifier
}

export interface ProjectState extends ProjectInfo, SessionEnrichment {
  state: SessionState;
  lastUpdated: string | null; // from status file timestamp, null if no status
  notificationMessage?: string; // from latest Notification event
  notificationTimestamp?: string; // from latest Notification event
  subagents?: SubagentInfo[];
  // Convenience count of active sub-agents; kept alongside subagents[] so clients
  // that don't parse the full array (e.g. simple status bars) can read a single field.
  subagentCount?: number;
}

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

    // Write a synthetic PermissionRequest so sub-agents without the hook still signal correctly.
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

  // Safety cap: trim to last 8KB when file exceeds 64KB.
  try {
    const s = await stat(logPath);
    if (s.size > MAX_STATUS_LOG_BYTES) {
      let raw = readFileSync(logPath, "utf-8");
      if (raw.length > STATUS_LOG_TAIL_BYTES) {
        raw = raw.slice(-STATUS_LOG_TAIL_BYTES);
      }
      // Drop partial first line after slicing mid-file.
      const firstNewline = raw.indexOf("\n");
      const trimmed = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
      writeFileSync(logPath, trimmed, "utf-8");
    }
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

/**
 * Filters out projects that have had no activity within the given number of hours.
 * Projects with null lastUpdated are always considered stale.
 * Pass maxInactivityHours <= 0 or Infinity to disable filtering.
 */
export function filterStaleProjects(
  projects: ProjectState[],
  maxInactivityHours: number,
): ProjectState[] {
  if (maxInactivityHours <= 0 || !Number.isFinite(maxInactivityHours))
    return projects;
  const cutoff = Date.now() - maxInactivityHours * 3600 * 1000;
  const closedCutoff = Date.now() - CLOSED_PROJECT_TTL_MS;
  return projects.filter((p) => {
    if (p.lastUpdated === null) return false;
    // An invalid/unparseable timestamp (NaN) is treated as non-stale (keep the project)
    // rather than silently dropping it from the dashboard.
    const time = new Date(p.lastUpdated).getTime();
    if (Number.isNaN(time)) return true;
    if (p.state === "closed") return time >= closedCutoff;
    return time >= cutoff;
  });
}

async function readProjectInfo(
  fullPath: string,
  dirName: string,
): Promise<ProjectInfo | null> {
  let isDir: boolean;
  try {
    const s = await stat(fullPath);
    isDir = s.isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;

  const latestJSONL = await findLatestJSONL(fullPath);
  if (latestJSONL === null) return null;

  const firstLine = await readFirstLine(latestJSONL);
  if (firstLine === null) return null;

  return {
    projectDir: dirName,
    cwd: firstLine.cwd,
    projectName: basename(firstLine.cwd),
    sessionId: firstLine.sessionId,
    latestJSONL,
    source: "claude",
  };
}

async function findLatestJSONL(dirPath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return null;
  }

  let latestPath: string | null = null;
  let latestMtime = 0;

  for (const entry of entries) {
    if (!entry.endsWith(JSONL_EXT)) continue;
    if (entry === STATUS_LOG_FILE) continue;
    const fullPath = join(dirPath, entry);
    try {
      const s = await stat(fullPath);
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latestPath = fullPath;
      }
    } catch {
      // skip unreadable files
    }
  }

  return latestPath;
}

async function readFirstLine(
  filePath: string,
): Promise<{ cwd: string; sessionId: string } | null> {
  try {
    const text = readFileSync(filePath, { encoding: "utf-8" }).slice(0, 4096);
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isFirstLineRecord(parsed)) return parsed;
      } catch {
        // Skip unparseable lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isFirstLineRecord(
  v: unknown,
): v is { cwd: string; sessionId: string } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.cwd === "string" && typeof obj.sessionId === "string";
}

// Strips the .jsonl extension from a path to get the corresponding session directory.
function sessionDirFromJSONL(jsonlPath: string): string {
  return jsonlPath.endsWith(JSONL_EXT)
    ? jsonlPath.slice(0, -JSONL_EXT.length)
    : jsonlPath;
}

let _defaultStore: SessionStore | undefined;

function getDefaultStore(): SessionStore {
  if (!_defaultStore) {
    _defaultStore = new SessionStore(DEFAULT_CLAUDE_DIR);
  }
  return _defaultStore;
}

export function replaceDefaultStore(store: SessionStore): void {
  // MUST be called in test beforeEach to prevent leaking to real ~/.claude/projects.
  _defaultStore = store;
}

// Backward-compat free function wrappers that delegate to the singleton
export function readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
  return getDefaultStore().readSessionTail(jsonlPath);
}

export function getProjectState(
  claudeDir: string = DEFAULT_CLAUDE_DIR,
  changedProjectDir?: string,
): Promise<ProjectState[]> {
  const store =
    claudeDir === getDefaultStore().claudeDir
      ? getDefaultStore()
      : new SessionStore(claudeDir);
  return store.getProjectState(changedProjectDir);
}

export function buildProjectState(
  project: ProjectInfo,
  claudeDir: string,
): Promise<ProjectState> {
  const store =
    claudeDir !== DEFAULT_CLAUDE_DIR
      ? new SessionStore(claudeDir)
      : getDefaultStore();
  return store.buildProjectState(project);
}

export function getSubagentInfos(
  latestJSONL: string,
  stoppedAtMs: number | null = null,
): Promise<SubagentInfo[]> {
  return getDefaultStore().getSubagentInfos(latestJSONL, stoppedAtMs);
}
