import type { Dirent } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Staleness window for waiting_for_permission signals.
const PERMISSION_STALE_MS = 5 * 60 * 1000;

// JSONL mtime threshold: files written within this window indicate active session.
// Claude writes continuously during turns so 60s covers any lag.
const JSONL_ACTIVE_THRESHOLD_MS = 60_000;

const JSONL_EXT = ".jsonl";

export const STATUS_LOG_FILE = "ccmon-status.jsonl";
export const STATUS_FILE_LEGACY = "ccmon-status.json";
export const MAX_STATUS_LOG_BYTES = 64 * 1024;

// Bytes to keep when trimming the status log after it exceeds MAX_STATUS_LOG_BYTES.
const STATUS_LOG_TAIL_BYTES = 8 * 1024;

// Maximum bytes to read on first access for large files (10 MB).
const MAX_FIRST_READ = 10 * 1024 * 1024;

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

export const DEFAULT_CLAUDE_DIR = join(
  Bun.env.HOME ?? "/root",
  ".claude",
  "projects",
);

const VALID_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting_for_permission",
  "stopped",
  "closed",
]);

// Keyed by projectDirPath; avoids re-parsing sessions-index.json unless mtime changed.
const sessionsIndexCache = new Map<
  string,
  { mtime: number; data: SessionsIndex | null }
>();

// Keyed by jsonlPath; avoids re-reading the tail unless the file changed.
interface SessionTailCache {
  mtime: number;
  fileSize: number;
  data: SessionTailInfo;
}
const sessionTailCache = new Map<string, SessionTailCache>();

// Keyed by projectDirPath (full path); holds the most recent ProjectState for each project.
// Populated on a full scan; updated in-place on targeted single-project rescans.
const projectStateCache = new Map<string, ProjectState>();

export type SessionState =
  | "running"
  | "waiting_for_permission"
  | "stopped"
  | "closed";

/**
 * Enrichment fields shared between main sessions and sub-agents,
 * extracted by scanning the tail of a JSONL file.
 */
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

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number; // epoch ms
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  modified?: string; // ISO 8601
  projectPath: string;
  isSidechain: boolean;
  gitBranch?: string;
}

export interface SessionsIndex {
  projectPath: string;
  entries: SessionsIndexEntry[];
}

export interface ProjectInfo {
  projectDir: string; // directory name under ~/.claude/projects/
  cwd: string; // working directory (from index projectPath or JSONL first line)
  projectName: string; // last segment of cwd
  sessionId: string; // from index or JSONL first line
  latestJSONL: string; // absolute path to most recent .jsonl file
  // Enriched fields from sessions-index.json (absent when falling back to JSONL scan)
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  sessionModified?: string; // ISO 8601 from index entry
  gitBranch?: string;
}

/**
 * Carries enrichment extracted from a JSONL tail scan, plus the per-session
 * agentDescriptions map needed to annotate sub-agents without a separate parse pass.
 */
export interface SessionTailInfo extends SessionEnrichment {
  // Maps agentId → description, populated from queue-operation enqueue entries.
  agentDescriptions: Map<string, string>;
}

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
  lastSubagentStoppedAt?: string;
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
 * Reads and validates sessions-index.json from projectDirPath.
 * Filters out sidechain entries and returns null if the file is missing,
 * unparseable, or has no usable (non-sidechain) entries.
 */
export async function readSessionsIndex(
  projectDirPath: string,
): Promise<SessionsIndex | null> {
  const indexPath = join(projectDirPath, "sessions-index.json");

  let mtime: number;
  try {
    const s = await stat(indexPath);
    mtime = s.mtimeMs;
  } catch {
    return null;
  }

  const cached = sessionsIndexCache.get(projectDirPath);
  if (cached !== undefined && cached.mtime === mtime) {
    return cached.data;
  }

  let raw: string;
  try {
    raw = await Bun.file(indexPath).text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sessionsIndexCache.set(projectDirPath, { mtime, data: null });
    return null;
  }

  if (!isSessionsIndexRaw(parsed)) {
    sessionsIndexCache.set(projectDirPath, { mtime, data: null });
    return null;
  }

  const entries = parsed.entries
    .filter((e) => !e.isSidechain)
    .map(
      (e): SessionsIndexEntry => ({
        sessionId: e.sessionId,
        fullPath: e.fullPath,
        fileMtime: e.fileMtime,
        firstPrompt:
          typeof e.firstPrompt === "string" ? e.firstPrompt : undefined,
        summary: typeof e.summary === "string" ? e.summary : undefined,
        messageCount:
          typeof e.messageCount === "number" ? e.messageCount : undefined,
        modified: typeof e.modified === "string" ? e.modified : undefined,
        projectPath: e.projectPath,
        isSidechain: e.isSidechain,
        gitBranch: typeof e.gitBranch === "string" ? e.gitBranch : undefined,
      }),
    );

  if (entries.length === 0) {
    sessionsIndexCache.set(projectDirPath, { mtime, data: null });
    return null;
  }

  // The sessions-index.json format has no top-level cwd field, so we use the first entry's
  // projectPath as the canonical cwd without validating that all entries agree. In practice
  // all entries in a single index file share the same project directory.
  const result: SessionsIndex = {
    projectPath: entries[0].projectPath,
    entries,
  };
  sessionsIndexCache.set(projectDirPath, { mtime, data: result });
  return result;
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
 * Suppresses the write when notification_type is 'permission_prompt' and the
 * current resolved state is already 'waiting_for_permission' to avoid duplicate signals.
 */
export async function writeNotificationStatus(
  projectDirPath: string,
  message: string,
  notificationType: string,
): Promise<void> {
  // Suppress: permission_prompt while already waiting_for_permission
  if (notificationType === "permission_prompt") {
    const events = await readStatusLog(projectDirPath);
    const currentState = resolveState(null, events);
    if (currentState === "waiting_for_permission") return;
  }

  const event: StatusEvent = {
    event: "Notification",
    state: "stopped",
    timestamp: new Date().toISOString(),
    session_id: "",
    working_dir: "",
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
      const file = Bun.file(logPath);
      const tail = await file.slice(-STATUS_LOG_TAIL_BYTES).text();
      // Drop partial first line after slicing mid-file.
      const firstNewline = tail.indexOf("\n");
      const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
      await Bun.write(logPath, trimmed);
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
  await Bun.write(logPath, `${JSON.stringify(event)}\n`);
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
  await Bun.write(
    agentStatusPath,
    JSON.stringify({ state: "stopped", timestamp: new Date().toISOString() }),
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
 * Scans claudeDir for Claude Code project subdirectories and returns metadata
 * parsed from the most recent JSONL session file in each.
 */
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

/**
 * Reads the status event log from {projectDir}/ccmon-status.jsonl.
 * Returns events in chronological order (oldest first).
 *
 * Only reads the last STATUS_LOG_TAIL_BYTES of the file to bound I/O.
 * Falls back to legacy ccmon-status.json if the .jsonl file is absent.
 */
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

/**
 * Returns the aggregated state for every discovered Claude Code project.
 * Combines scan, status file, staleness check, and liveness detection.
 *
 * If changedProjectDir (full path) is provided and the cache is populated,
 * only that project is rescanned and merged into the cached state, avoiding
 * a full I/O sweep of all projects on every watcher event.
 */
export async function getProjectState(
  claudeDir: string = DEFAULT_CLAUDE_DIR,
  changedProjectDir?: string,
): Promise<ProjectState[]> {
  // Targeted refresh: only rescan the changed project when the cache is warm.
  if (changedProjectDir !== undefined && projectStateCache.size > 0) {
    const dirName = basename(changedProjectDir);
    const info = await readProjectInfo(changedProjectDir, dirName);
    if (info !== null) {
      const updatedState = await buildProjectState(info, claudeDir);
      projectStateCache.set(changedProjectDir, updatedState);
    } else {
      // Project disappeared — remove from cache.
      projectStateCache.delete(changedProjectDir);
    }
    // Reset to basename before re-disambiguating so stale expanded names don't
    // persist when projects are added/removed.
    const allStates = [...projectStateCache.values()];
    for (const s of allStates) {
      s.projectName = basename(s.cwd);
    }
    disambiguateProjectNames(allStates);
    for (const s of allStates) {
      projectStateCache.set(join(claudeDir, s.projectDir), s);
    }
    return allStates;
  }

  // Full scan: populate the cache.
  const projects = await scanProjects(claudeDir);
  if (projects.length === 0) {
    projectStateCache.clear();
    return [];
  }

  const states = await Promise.all(
    projects.map((p) => buildProjectState(p, claudeDir)),
  );

  disambiguateProjectNames(states);

  projectStateCache.clear();
  for (let i = 0; i < projects.length; i++) {
    const fullPath = join(claudeDir, projects[i].projectDir);
    projectStateCache.set(fullPath, states[i]);
  }

  return states;
}

/**
 * Expands projectName for projects that share the same basename by prepending
 * parent path segments from cwd until all names within each collision group are
 * unique. Projects with already-unique basenames are left unchanged.
 * Mutates the array in place.
 */
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

    let segments = 2;
    while (true) {
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

    for (const p of group) {
      const parts = p.cwd.split("/");
      p.projectName = parts.slice(-segments).join("/");
    }
  }
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

/**
 * Returns SubagentInfo for every sub-agent JSONL found in {sessionDir}/subagents/.
 * Each entry includes enrichment data from readSessionTail plus identity fields
 * (agentId, jsonlPath, isActive, optional slug). Returns [] if the dir is absent.
 */
export async function getSubagentInfos(
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
  // since readSessionTail caches by path and is called again in buildProjectState.
  // Read parent session tail for the agentDescriptions map. When called from
  // buildProjectState this is a cache hit because buildProjectState already called
  // readSessionTail for the same path in the same event-loop turn.
  const parentTail = await readSessionTail(latestJSONL);

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
        stoppedAtMs !== null && mtimeMs <= stoppedAtMs + SUBAGENT_STOP_GRACE_MS;
      let isActive = !stoppedRecently && mtimeMs > cutoff;

      // A per-agent ccmon-status.json with state "stopped" overrides mtime-based detection.
      if (isActive) {
        const agentStatusPath = join(
          subagentsDir,
          `${nameWithout}.ccmon-status.json`,
        );
        try {
          const raw = await Bun.file(agentStatusPath).text();
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.state === "stopped") isActive = false;
        } catch {
          // Status file absent or unreadable — fall back to mtime-based detection.
        }
      }

      // Exclude completed agents older than 5 minutes to keep payload lean.
      if (!isActive && mtimeMs < expiryCutoff) return null;

      const enrichment = await readSessionTail(jsonlPath);

      // Read slug and launch timestamp from first line (best-effort).
      // launchTime uses the recorded first-entry timestamp rather than mtime so that
      // a long-running agent that finishes last doesn't sort ahead of a later-launched one.
      let slug: string | undefined;
      let launchTime: string = new Date(mtimeMs).toISOString(); // mtime fallback
      try {
        const file = Bun.file(jsonlPath);
        const text = await file.slice(0, 512).text();
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

/**
 * Reads a JSONL session file and extracts enrichment fields by scanning lines
 * from newest to oldest. On first read the entire file is parsed (up to 10 MB);
 * subsequent reads only parse bytes appended since the last read (delta mode).
 * If the file shrinks the cache is reset and the full file is re-read.
 */
export async function readSessionTail(
  jsonlPath: string,
): Promise<SessionTailInfo> {
  let mtimeMs: number;
  let size: number;
  try {
    const s = await stat(jsonlPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    return { agentDescriptions: new Map() };
  }

  const cached = sessionTailCache.get(jsonlPath);
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
    const file = Bun.file(jsonlPath);
    text = await file.slice(startOffset).text();
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

  sessionTailCache.set(jsonlPath, {
    mtime: mtimeMs,
    fileSize: size,
    data: merged,
  });
  return merged;
}

/**
 * Resets all module-level caches. Only call from tests.
 */
export function _resetCachesForTesting(): void {
  sessionsIndexCache.clear();
  sessionTailCache.clear();
  projectStateCache.clear();
}

/**
 * Extracts a slash command string from a user message content string.
 * Returns "/command-name [args]" if a <command-name> tag is found, null otherwise.
 */
function extractCommand(content: string): string | null {
  const nameMatch = content.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  const argsMatch = content.match(/<command-args>([^<]*)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return args ? `${name} ${args}` : name;
}

/**
 * Determines the byte offset and base data for a readSessionTail read.
 * Returns startOffset === -1 to signal a cache hit (no re-read needed).
 */
function computeReadRange(
  cached: SessionTailCache | undefined,
  mtimeMs: number,
  size: number,
): { startOffset: number; baseData: SessionTailInfo; isDelta: boolean } {
  if (
    cached !== undefined &&
    cached.mtime === mtimeMs &&
    cached.fileSize === size
  ) {
    // Nothing changed — signal cache hit.
    return { startOffset: -1, baseData: cached.data, isDelta: false };
  } else if (cached !== undefined && size > cached.fileSize) {
    // Delta read: only parse the new bytes appended since last read.
    // Applies even when mtime appears unchanged (sub-second writes on fast systems).
    // Copy the cached agentDescriptions so new scan entries accumulate independently.
    return {
      startOffset: cached.fileSize,
      baseData: {
        ...cached.data,
        agentDescriptions: new Map(cached.data.agentDescriptions),
      },
      isDelta: true,
    };
  } else {
    // Full read (first read, file shrank, or mtime changed without size growth).
    return {
      startOffset: Math.max(0, size - MAX_FIRST_READ),
      baseData: { agentDescriptions: new Map() },
      isDelta: false,
    };
  }
}

/**
 * Reversed-scan pass over JSONL lines (newest-to-oldest).
 * Extracts the most-recent user activity, assistant activity, model, token counts,
 * and agent descriptions. Uses TodoWrite as a fallback when no TaskCreate tasks exist.
 */
function scanEnrichment(
  lines: string[],
  scannedTasks: Map<string, TaskInfo> | null,
  baseData: SessionTailInfo,
): SessionTailInfo {
  const reversed = lines.slice().reverse();
  const result: SessionTailInfo = { agentDescriptions: new Map() };
  // Task tool correlation: assistant tool_use "Task" carries description; the paired
  // user tool_result carries toolUseResult.agentId. Since we scan in reverse, user
  // entries arrive before their paired assistant entries. Collect both sides and
  // resolve after the loop.
  const taskToolDescriptions = new Map<string, string>(); // tool_use_id → description
  const pendingToolResults = new Map<string, string>(); // tool_use_id → agentId
  let foundUserActivity = false;
  let foundAssistantActivity = false;
  let foundModel = false;
  // Only suppress the TodoWrite fallback when at least one task was resolved via
  // TaskCreate/TaskUpdate; an empty scannedTasks Map (creates seen but results missing)
  // does not count.
  let foundTasks =
    (scannedTasks !== null && scannedTasks.size > 0) ||
    baseData.tasks !== undefined;
  // inputTokens: last-seen value (cache_read grows monotonically — summing inflates it).
  let scanInputTokens: number | undefined;
  let scanOutputTokens = 0;

  for (const line of reversed) {
    // Don't break early even when other fields are found — need to accumulate output tokens.
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry.type;
    const message = entry.message as Record<string, unknown> | undefined;

    if (type === "user") {
      // Collect Task tool_result + toolUseResult.agentId regardless of foundUserActivity
      // so the full session is scanned for agent description correlations.
      if (message && Array.isArray(message.content)) {
        const toolUseResult = entry.toolUseResult as
          | Record<string, unknown>
          | undefined;
        const agentId =
          typeof toolUseResult?.agentId === "string"
            ? toolUseResult.agentId
            : undefined;
        if (agentId !== undefined) {
          for (const block of message.content as unknown[]) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
              pendingToolResults.set(b.tool_use_id, agentId);
            }
          }
        }
      }

      if (!message || foundUserActivity) continue;
      const content = message.content;
      if (typeof content === "string") {
        const isXml = content.startsWith("<");
        const cmd = isXml ? extractCommand(content) : null;
        if (cmd !== null) {
          result.latestUserActivity = { text: cmd, isCommand: true };
          foundUserActivity = true;
        } else if (!isXml) {
          // Exclude <-prefixed content that isn't a recognized command.
          result.latestUserActivity = {
            text: content.slice(0, 200),
            isCommand: false,
          };
          foundUserActivity = true;
        }
      }
    }

    if (type === "assistant" && message) {
      if (!foundModel && typeof message.model === "string") {
        result.model = message.model;
        foundModel = true;
      }

      // input tokens: last-seen value wins (cache_read_input_tokens grows monotonically).
      // output tokens: accumulate all per-call deltas.
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage !== undefined) {
        const input =
          typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const cacheCreate =
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0;
        const cacheRead =
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0;
        if (scanInputTokens === undefined)
          scanInputTokens = input + cacheCreate + cacheRead;
        if (typeof usage.output_tokens === "number")
          scanOutputTokens += usage.output_tokens;
      }

      if (Array.isArray(message.content)) {
        const contentBlocks = message.content as unknown[];

        if (!foundTasks) {
          const todoWriteResult = scanTodoWrite(contentBlocks);
          if (todoWriteResult !== null) {
            result.tasksDone = todoWriteResult.tasksDone;
            result.tasksTotal = todoWriteResult.tasksTotal;
            foundTasks = true;
          }
        }

        // First assistant entry in reversed scan (= most recent chronologically) sets
        // latestAssistantActivity. Text and tool are extracted from the same entry.
        if (!foundAssistantActivity) {
          const textBlock = contentBlocks.find(isTextBlock);
          const toolUse = contentBlocks.find(isToolUseBlock);
          if (textBlock !== undefined || toolUse !== undefined) {
            result.latestAssistantActivity = {
              text: textBlock ? textBlock.text.slice(0, 200) : undefined,
              tool: toolUse ? toolUse.name : undefined,
            };
            foundAssistantActivity = true;
          }
        }

        // Collect Task tool_use id → description for sub-agent correlation.
        for (const block of contentBlocks) {
          const b = block as Record<string, unknown>;
          if (
            b.type === "tool_use" &&
            b.name === "Task" &&
            typeof b.id === "string"
          ) {
            const input = b.input as Record<string, unknown> | undefined;
            if (typeof input?.description === "string") {
              taskToolDescriptions.set(b.id, input.description);
            }
          }
        }
      }
    }

    // progress entries carry TodoWrite tool calls (legacy fallback path).
    if (!foundTasks && type === "progress") {
      const data = entry.data as Record<string, unknown> | undefined;
      const outerMsg = data?.message as Record<string, unknown> | undefined;
      const innerMsg = outerMsg?.message as Record<string, unknown> | undefined;
      const content = innerMsg?.content;
      if (Array.isArray(content)) {
        const todoWriteResult = scanTodoWrite(content as unknown[]);
        if (todoWriteResult !== null) {
          result.tasksDone = todoWriteResult.tasksDone;
          result.tasksTotal = todoWriteResult.tasksTotal;
          foundTasks = true;
        }
      }
    }

    // queue-operation enqueue entries map agentId → description for sub-agents.
    if (type === "queue-operation") {
      const operation = entry.operation;
      if (operation === "enqueue" && typeof entry.content === "string") {
        try {
          const parsed = JSON.parse(entry.content) as Record<string, unknown>;
          if (
            typeof parsed.task_id === "string" &&
            typeof parsed.description === "string"
          ) {
            result.agentDescriptions.set(parsed.task_id, parsed.description);
          }
        } catch {
          // malformed content — skip
        }
      }
    }
  }

  // Resolve Task tool_use correlations: tool_use_id links description (from assistant)
  // to agentId (from user toolUseResult).
  for (const [toolUseId, agentId] of pendingToolResults) {
    const description = taskToolDescriptions.get(toolUseId);
    if (description !== undefined) {
      result.agentDescriptions.set(agentId, description);
    }
  }

  if (scanInputTokens !== undefined && scanInputTokens > 0)
    result.inputTokens = scanInputTokens;
  if (scanOutputTokens > 0) result.outputTokens = scanOutputTokens;
  return result;
}

/**
 * Merges a fresh scan result with the base (cached) data into a final SessionTailInfo.
 *
 * Task merge strategy: base tasks overlaid with new scan results so delta reads
 * accumulate all tasks across the session's history.
 * Token merge: inputTokens last-wins (monotonically growing cache_read — summing inflates);
 * outputTokens additive (per-call deltas that should be summed).
 * agentDescriptions: accumulated from both base and new scan.
 * Undefined-valued optional keys are stripped from the returned object so callers
 * receive a clean record without dangling undefined properties.
 */
function mergeEnrichment(
  scannedTasks: Map<string, TaskInfo> | null,
  scanResult: SessionTailInfo,
  baseData: SessionTailInfo,
): SessionTailInfo {
  let mergedTasks: TaskInfo[] | undefined;
  let mergedTasksDone: number | undefined;
  let mergedTasksTotal: number | undefined;

  if (scannedTasks !== null || baseData.tasks !== undefined) {
    // Build merged task map: base tasks first, then overlay new scan results.
    const taskMap = new Map<string, TaskInfo>();
    if (baseData.tasks) {
      for (const t of baseData.tasks) taskMap.set(t.id, { ...t });
    }
    if (scannedTasks !== null) {
      for (const [id, t] of scannedTasks) taskMap.set(id, { ...t });
    }
    const taskList = [...taskMap.values()].sort((a, b) => {
      const na = parseInt(a.id, 10);
      const nb = parseInt(b.id, 10);
      return na - nb;
    });
    mergedTasks = taskList;
    const nonDeleted = taskList.filter((t) => t.status !== "deleted");
    mergedTasksTotal = nonDeleted.length;
    mergedTasksDone = nonDeleted.filter((t) => t.status === "completed").length;
  } else if (scanResult.tasksTotal !== undefined) {
    // TodoWrite path: scanResult already has tasksDone/tasksTotal set.
    mergedTasksDone = scanResult.tasksDone;
    mergedTasksTotal = scanResult.tasksTotal;
  } else {
    mergedTasksDone = baseData.tasksDone;
    mergedTasksTotal = baseData.tasksTotal;
    mergedTasks = baseData.tasks;
  }

  const mergedInputTokens = scanResult.inputTokens ?? baseData.inputTokens;
  const mergedOutputTokens =
    (baseData.outputTokens ?? 0) + (scanResult.outputTokens ?? 0);

  const mergedDescriptions = baseData.agentDescriptions;
  for (const [id, desc] of scanResult.agentDescriptions) {
    mergedDescriptions.set(id, desc);
  }

  const merged: SessionTailInfo = {
    agentDescriptions: mergedDescriptions,
  };
  const latestUserActivity =
    scanResult.latestUserActivity ?? baseData.latestUserActivity;
  if (latestUserActivity !== undefined)
    merged.latestUserActivity = latestUserActivity;
  const latestAssistantActivity =
    scanResult.latestAssistantActivity ?? baseData.latestAssistantActivity;
  if (latestAssistantActivity !== undefined)
    merged.latestAssistantActivity = latestAssistantActivity;
  const model = scanResult.model ?? baseData.model;
  if (model !== undefined) merged.model = model;
  if (mergedTasks !== undefined) merged.tasks = mergedTasks;
  if (mergedTasksDone !== undefined) merged.tasksDone = mergedTasksDone;
  if (mergedTasksTotal !== undefined) merged.tasksTotal = mergedTasksTotal;
  const mergedInputTokensFinal =
    mergedInputTokens !== undefined && mergedInputTokens > 0
      ? mergedInputTokens
      : undefined;
  if (mergedInputTokensFinal !== undefined)
    merged.inputTokens = mergedInputTokensFinal;
  const mergedOutputTokensFinal =
    mergedOutputTokens > 0 ? mergedOutputTokens : undefined;
  if (mergedOutputTokensFinal !== undefined)
    merged.outputTokens = mergedOutputTokensFinal;
  return merged;
}

/**
 * Forward-scans JSONL lines for TaskCreate/TaskUpdate tool_use blocks.
 * Returns a Map<taskId, TaskInfo> if any TaskCreate blocks were found, null otherwise.
 * IDs are extracted from the tool_result response text ("Task #N created successfully").
 * TaskUpdate patches status and optionally subject/activeForm on existing entries.
 */
function scanTaskCreateUpdate(
  lines: string[],
  baseTasks?: TaskInfo[],
): Map<string, TaskInfo> | null {
  // Maps tool_use_id → { subject, activeForm } for pending TaskCreate calls awaiting tool_result.
  const pendingCreates = new Map<
    string,
    { subject: string; activeForm?: string }
  >();
  // Seed with base tasks so TaskUpdate entries in delta reads can resolve pre-existing tasks.
  const tasks = new Map<string, TaskInfo>(
    baseTasks?.map((t) => [t.id, { ...t }]),
  );

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry.type;
    const message = entry.message as Record<string, unknown> | undefined;

    if (type === "assistant" && message && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        if (typeof b.id !== "string") continue;
        const input = b.input as Record<string, unknown> | undefined;
        if (!input) continue;

        if (b.name === "TaskCreate" && typeof input.subject === "string") {
          // Record pending create keyed by tool_use_id to match tool_result later.
          pendingCreates.set(b.id, {
            subject: input.subject,
            activeForm:
              typeof input.activeForm === "string"
                ? input.activeForm
                : undefined,
          });
        }

        if (b.name === "TaskUpdate" && typeof input.taskId === "string") {
          const existing = tasks.get(input.taskId);
          if (existing) {
            if (typeof input.status === "string")
              existing.status = input.status;
            if (typeof input.subject === "string")
              existing.subject = input.subject;
            if (typeof input.activeForm === "string")
              existing.activeForm = input.activeForm;
          }
        }
      }
    }

    // User messages carry tool_result blocks that confirm TaskCreate with the assigned ID.
    if (type === "user" && message && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        if (typeof b.tool_use_id !== "string") continue;

        const pending = pendingCreates.get(b.tool_use_id);
        if (!pending) continue;

        // Extract task ID from result text like "Task #3 created successfully"
        let taskId: string | undefined;
        const content = b.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content as unknown[])
                  .filter(
                    (c): c is { type: string; text: string } =>
                      typeof c === "object" &&
                      c !== null &&
                      (c as Record<string, unknown>).type === "text",
                  )
                  .map((c) => c.text)
                  .join("")
              : "";
        const match = text.match(/Task #(\d+)/i);
        if (match) taskId = match[1];

        if (taskId) {
          tasks.set(taskId, {
            id: taskId,
            subject: pending.subject,
            status: "pending",
            activeForm: pending.activeForm,
          });
          pendingCreates.delete(b.tool_use_id);
        }
      }
    }
  }

  // Only return non-null when at least one task was resolved via tool_result.
  // An empty Map (creates seen but no tool_results yet) must not suppress the
  // TodoWrite fallback or produce a premature "0/0" display.
  return tasks.size > 0 ? tasks : null;
}

function scanTodoWrite(
  contentBlocks: unknown[],
): { tasksDone: number; tasksTotal: number } | null {
  const todoWrite = contentBlocks.find(
    (
      item,
    ): item is { type: string; name: string; input: Record<string, unknown> } =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "tool_use" &&
      (item as Record<string, unknown>).name === "TodoWrite",
  );
  if (todoWrite === undefined) return null;
  const input = (todoWrite as Record<string, unknown>).input as
    | Record<string, unknown>
    | undefined;
  if (input === undefined || !Array.isArray(input.todos)) return null;
  const todos = input.todos as Array<{ status: string }>;
  return {
    tasksTotal: todos.length,
    tasksDone: todos.filter((t) => t.status === "completed").length,
  };
}

function isTextBlock(b: unknown): b is { type: string; text: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as Record<string, unknown>).type === "text" &&
    typeof (b as Record<string, unknown>).text === "string"
  );
}

function isToolUseBlock(b: unknown): b is { type: string; name: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as Record<string, unknown>).type === "tool_use" &&
    typeof (b as Record<string, unknown>).name === "string"
  );
}

async function buildProjectState(
  project: ProjectInfo,
  claudeDir: string,
): Promise<ProjectState> {
  const projectDirPath = join(claudeDir, project.projectDir);
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
  const tail = await readSessionTail(project.latestJSONL);

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
      ? await getSubagentInfos(project.latestJSONL, stoppedAtMs)
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
    tasksDone: tail.tasksDone,
    tasksTotal: tail.tasksTotal,
    inputTokens: tail.inputTokens,
    outputTokens: tail.outputTokens,
    notificationMessage,
    notificationTimestamp,
    subagents: subagents.length > 0 ? subagents : undefined,
    subagentCount: subagentCount > 0 ? subagentCount : undefined,
    gitBranch: project.gitBranch,
  };
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

  // Prefer sessions-index.json for richer metadata; fall back to JSONL first-line parse
  const index = await readSessionsIndex(fullPath);
  if (index !== null) {
    const latest = index.entries.reduce((a, b) =>
      a.fileMtime > b.fileMtime ? a : b,
    );

    // The index can grow stale: scan direct-child .jsonl files for any with a newer
    // mtime than what the index recorded. Subdirectory files (subagent JSONLs under
    // {uuid}/subagents/) are excluded by limiting readdir to depth-1 entries only.
    let latestJSONL = latest.fullPath;
    const newerOnDisk = await findLatestJSONL(fullPath);
    if (newerOnDisk !== null) {
      let diskMtime = 0;
      try {
        const s = await stat(newerOnDisk);
        diskMtime = s.mtimeMs;
      } catch {
        // ignore; keep index entry
      }
      if (diskMtime > latest.fileMtime) {
        latestJSONL = newerOnDisk;
      }
    }

    return {
      projectDir: dirName,
      cwd: index.projectPath,
      projectName: basename(index.projectPath),
      sessionId: latest.sessionId,
      latestJSONL,
      summary: latest.summary,
      firstPrompt: latest.firstPrompt,
      messageCount: latest.messageCount,
      sessionModified: latest.modified,
      gitBranch: latest.gitBranch,
    };
  }

  const latestJSONL = await findLatestJSONL(fullPath);
  if (latestJSONL === null) return null;

  const firstLine = await readFirstLine(latestJSONL);
  if (firstLine === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }

  if (!isFirstLineRecord(parsed)) return null;

  return {
    projectDir: dirName,
    cwd: parsed.cwd,
    projectName: basename(parsed.cwd),
    sessionId: parsed.sessionId,
    latestJSONL,
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

async function readFirstLine(filePath: string): Promise<string | null> {
  try {
    const text = await Bun.file(filePath).slice(0, 4096).text();
    const newline = text.indexOf("\n");
    return newline === -1 ? text.trim() : text.slice(0, newline).trim();
  } catch {
    return null;
  }
}

/** Events that don't carry session state (excluded from state resolution). */
const NON_STATE_EVENTS = new Set(["Notification", "SubagentStop"]);

/** Events that resolve an outstanding PermissionRequest. */
const PERMISSION_RESOLVERS = new Set([
  "Stop",
  "SessionEnd",
  "UserPromptSubmit",
]);

/**
 * Resolves session state from the status event log and JSONL mtime.
 *
 * Priority order:
 * 1. Unresolved PermissionRequest (not followed by Stop/SessionEnd/UserPromptSubmit,
 *    fresh < PERMISSION_STALE_MS) → waiting_for_permission
 * 2. Latest state-bearing event is SessionEnd → closed
 * 2b. Latest state-bearing event is Stop → stopped
 * 3. Latest state-bearing event is PostToolUse/UserPromptSubmit within JSONL_ACTIVE_THRESHOLD_MS → running
 * 4. JSONL mtime within JSONL_ACTIVE_THRESHOLD_MS → running
 * 5. Default → stopped
 *
 * Exported for unit testing only.
 */
export function resolveState(
  jsonlMtimeMs: number | null,
  events: StatusEvent[],
): SessionState {
  // Filter to state-bearing events only.
  const stateful = events.filter((e) => !NON_STATE_EVENTS.has(e.event));

  // Priority 1: scan backward for unresolved PermissionRequest.
  // A PermissionRequest is resolved if the same session later fires PostToolUse
  // (the tool ran, meaning the user clicked Allow). Sub-agent PostToolUse events
  // have different session_id values and must not resolve a main session's request.
  for (let i = stateful.length - 1; i >= 0; i--) {
    const e = stateful[i];
    if (PERMISSION_RESOLVERS.has(e.event)) break;
    if (e.event === "PermissionRequest") {
      // Forward-scan from this position for a same-session PostToolUse.
      const sid = e.session_id;
      let resolved = false;
      for (let j = i + 1; j < stateful.length; j++) {
        if (
          stateful[j].session_id === sid &&
          stateful[j].event === "PostToolUse"
        ) {
          resolved = true;
          break;
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

  // Priority 5: default.
  return "stopped";
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

function isFirstLineRecord(
  v: unknown,
): v is { cwd: string; sessionId: string } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.cwd === "string" && typeof obj.sessionId === "string";
}

type RawIndexEntry = {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: unknown;
  summary?: unknown;
  messageCount?: unknown;
  modified?: unknown;
  gitBranch?: unknown;
  projectPath: string;
  isSidechain: boolean;
};

function isSessionsIndexRaw(v: unknown): v is { entries: RawIndexEntry[] } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) return false;
  return obj.entries.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).sessionId === "string" &&
      typeof (e as Record<string, unknown>).fullPath === "string" &&
      typeof (e as Record<string, unknown>).fileMtime === "number" &&
      typeof (e as Record<string, unknown>).projectPath === "string" &&
      typeof (e as Record<string, unknown>).isSidechain === "boolean",
  );
}

// Strips the .jsonl extension from a path to get the corresponding session directory.
// Both getSubagentInfos and the former countActiveSubagents rely on this convention.
function sessionDirFromJSONL(jsonlPath: string): string {
  return jsonlPath.endsWith(JSONL_EXT)
    ? jsonlPath.slice(0, -JSONL_EXT.length)
    : jsonlPath;
}
