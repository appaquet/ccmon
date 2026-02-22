import { readdir, stat, readlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// REVIEW: code-style-reviewer - ASCII art section banners ("─── Constants ───") are discouraged: comments should describe "why" not delineate structure. The file already follows a clear top-level layout; these dividers add noise without information. Consider removing them (applies to all banner comments in this file).

// ─── Constants ───────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Maximum bytes to read on first access for large files (10 MB).
const MAX_FIRST_READ = 10 * 1024 * 1024;

// Sub-agents write continuously while active; 45s covers any lag without
// counting finished agents as still running.
const SUBAGENT_ACTIVE_THRESHOLD_MS = 45 * 1000;

// Completed sub-agents are excluded from the payload after this duration
// to keep the state map lean.
const SUBAGENT_EXPIRY_MS = 5 * 60 * 1000;

const DEFAULT_CLAUDE_DIR = join(
  Bun.env.HOME ?? '/root',
  '.claude',
  'projects',
);

const VALID_STATES: ReadonlySet<string> = new Set([
  'running',
  'waiting_for_permission',
  'stopped',
]);

// ─── Module-level Caches ─────────────────────────────────────────────────────

// Caches the pgrep + /proc liveness scan result for 2.5s to avoid repeated
// process enumeration on every poll cycle.
// REVIEW: architecture-reviewer - Module-level mutable singletons for all caches create implicit global state. The module is non-reentrant: tests must call `_resetCachesForTesting()` to isolate between runs. Consider encapsulating all caches in a class or factory (e.g., `createSessionStore()`) so each caller owns an instance and tests create fresh ones without an exported reset escape hatch. This would eliminate the `_resetCachesForTesting` test-infrastructure leak from the public API.
let livenessCache: { result: Set<string>; ts: number } | null = null;

// Keyed by projectDirPath; avoids re-parsing sessions-index.json unless mtime changed.
const sessionsIndexCache = new Map<string, { mtime: number; data: SessionsIndex | null }>();

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

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionState = 'running' | 'waiting_for_permission' | 'stopped';

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
  agentId: string;          // extracted from filename: agent-{agentId}.jsonl
  slug?: string;            // from first line of sub-agent JSONL
  description?: string;     // from parent session queue-operation enqueue entry
  jsonlPath: string;        // absolute path to sub-agent JSONL
  isActive: boolean;        // mtime within last 45 seconds
  lastMessageTime: string;  // ISO 8601 from file mtime
  // REVIEW: architecture-reviewer - `launchTime` and `lastMessageTime` are both derived from the same file mtime and assigned identical values in `getSubagentInfos`. The dual fields expose misleading semantics: `launchTime` implies agent start time, but mtime only reflects last-write time. Either derive a true launch time (e.g., parse the first-line timestamp from the agent JSONL) or collapse to a single accurately named field (e.g., `lastActivityTime`) to remove the duplicated surface.
  launchTime: string;       // ISO 8601 from file mtime (used as proxy for launch time)
}

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;    // epoch ms
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  modified?: string;    // ISO 8601
  projectPath: string;
  isSidechain: boolean;
  gitBranch?: string;
}

export interface SessionsIndex {
  projectPath: string;
  entries: SessionsIndexEntry[];
}

export interface ProjectInfo {
  projectDir: string;     // directory name under ~/.claude/projects/
  cwd: string;            // working directory (from index projectPath or JSONL first line)
  projectName: string;    // last segment of cwd
  sessionId: string;      // from index or JSONL first line
  latestJSONL: string;    // absolute path to most recent .jsonl file
  // Enriched fields from sessions-index.json (absent when falling back to JSONL scan)
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  sessionModified?: string; // ISO 8601 from index entry
  gitBranch?: string;
}

// REVIEW: code-style-reviewer - This comment describes "what" the interface is (same as a reader can see from the code) and its relationship to SessionEnrichment (already visible from `extends`). Prefer a "why" comment or a JSDoc that documents the purpose, not the structure.
// SessionTailInfo extends SessionEnrichment with agent description metadata
// accumulated during the parent session's JSONL parse pass.
export interface SessionTailInfo extends SessionEnrichment {
  // Maps agentId → description, populated from queue-operation enqueue entries.
  agentDescriptions: Map<string, string>;
}

export interface StatusFile {
  state: SessionState;
  timestamp: string;    // ISO 8601
  session_id: string;
  working_dir: string;
  notificationMessage?: string;    // set by Notification hook events
  notificationTimestamp?: string;  // ISO 8601, updated on each notification
}

export interface ProjectState extends ProjectInfo {
  state: SessionState;
  lastUpdated: string | null; // from status file timestamp, null if no status
  // REVIEW: code-style-reviewer - `latestUserActivity`, `latestAssistantActivity`, and `model` are already declared in `SessionEnrichment`. Re-declaring them here (even with identical types) creates a maintenance burden: changing the shape in `SessionEnrichment` also requires updating `ProjectState`. Since `ProjectState` doesn't extend `SessionEnrichment`, these are implicit duplicates. Consider extending `SessionEnrichment` or removing the re-declarations and relying on the spread in `buildProjectState`.
  // Enrichment fields — populated for all states
  latestUserActivity?: { text: string; isCommand: boolean };
  latestAssistantActivity?: { text?: string; tool?: string };
  model?: string;
  tasksDone?: number;
  tasksTotal?: number;
  inputTokens?: number;
  outputTokens?: number;
  subagents?: SubagentInfo[];
  // Derived from subagents for backward compatibility
  subagentCount?: number;
}

// REVIEW: code-style-reviewer - Section banner "─── Public API ───" marks code organization with a comment rather than letting file structure speak for itself. Per project code style, if section markers seem necessary the file should be split instead. Same issue applies to "─── Exported Test Helpers ───" and "─── Private Helpers ───" banners below.

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Reads and validates sessions-index.json from projectDirPath.
 * Filters out sidechain entries and returns null if the file is missing,
 * unparseable, or has no usable (non-sidechain) entries.
 */
export async function readSessionsIndex(projectDirPath: string): Promise<SessionsIndex | null> {
  const indexPath = join(projectDirPath, 'sessions-index.json');

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
    .map((e): SessionsIndexEntry => ({
      sessionId: e.sessionId,
      fullPath: e.fullPath,
      fileMtime: e.fileMtime,
      firstPrompt: typeof e.firstPrompt === 'string' ? e.firstPrompt : undefined,
      summary: typeof e.summary === 'string' ? e.summary : undefined,
      messageCount: typeof e.messageCount === 'number' ? e.messageCount : undefined,
      modified: typeof e.modified === 'string' ? e.modified : undefined,
      projectPath: e.projectPath,
      isSidechain: e.isSidechain,
      gitBranch: typeof e.gitBranch === 'string' ? e.gitBranch : undefined,
    }));

  if (entries.length === 0) {
    sessionsIndexCache.set(projectDirPath, { mtime, data: null });
    return null;
  }

  // REVIEW: code-correctness-reviewer - `entries[0].projectPath` is used as the canonical project path for the entire index, but the code does not verify that all entries share the same `projectPath`. In a malformed or corrupted index where entries have different `projectPath` values, the first non-sidechain entry's path is used as the cwd for all subsequent lookups. If the first entry has an incorrect `projectPath`, all session matching (including `resolveProjectDir` exact-match logic) will fail silently. Consider verifying consistency or reading from a top-level `originalPath` field if available.
  const result: SessionsIndex = { projectPath: entries[0].projectPath, entries };
  sessionsIndexCache.set(projectDirPath, { mtime, data: result });
  return result;
}

/**
 * Maps a Claude hook event name to the corresponding SessionState.
 * Returns null for events that don't change state (Notification, unrecognized).
 */
export function mapHookEventToState(hookEvent: string): SessionState | null {
  switch (hookEvent) {
    case 'UserPromptSubmit': return 'running';
    case 'PostToolUse':      return 'running';
    case 'PermissionRequest': return 'waiting_for_permission';
    case 'Stop':             return 'stopped';
    case 'SessionEnd':       return 'stopped';
    // Notification events carry a message but do not change the session state.
    case 'Notification':     return null;
    default:                 return null;
  }
}

/**
 * Handles a Notification hook event by merging notificationMessage and
 * notificationTimestamp into the existing status file without altering state.
 *
 * Suppresses the write when notification_type is 'permission_prompt' and the
 * current state is already 'waiting_for_permission' to avoid duplicate signals.
 * When no status file exists, writes a new one with state 'stopped'.
 */
export async function writeNotificationStatus(
  projectDirPath: string,
  message: string,
  notificationType: string,
): Promise<void> {
  const existing = await readStatus(projectDirPath);

  // Suppress: permission_prompt while already waiting_for_permission
  if (notificationType === 'permission_prompt' && existing?.state === 'waiting_for_permission') {
    return;
  }

  const base: StatusFile = existing ?? {
    state: 'stopped',
    timestamp: new Date().toISOString(),
    session_id: '',
    working_dir: '',
  };

  const updated: StatusFile = {
    ...base,
    notificationMessage: message,
    notificationTimestamp: new Date().toISOString(),
  };

  await writeStatus(projectDirPath, updated);
}

/**
 * Writes a StatusFile as JSON to {projectDirPath}/status.local.json.
 */
export async function writeStatus(projectDirPath: string, status: StatusFile): Promise<void> {
  const statusPath = join(projectDirPath, 'status.local.json');
  await Bun.write(statusPath, JSON.stringify(status));
}

/**
 * Scans claudeDir for Claude Code project subdirectories and returns metadata
 * parsed from the most recent JSONL session file in each.
 */
export async function scanProjects(claudeDir: string = DEFAULT_CLAUDE_DIR): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(claudeDir);
  } catch {
    return [];
  }

  const results: ProjectInfo[] = [];

  for (const entry of entries) {
    if (entry === 'subagents') continue;

    const fullPath = join(claudeDir, entry);
    const info = await readProjectInfo(fullPath, entry);
    if (info !== null) {
      results.push(info);
    }
  }

  return results;
}

/**
 * Reads and validates status.local.json from projectDir.
 * Returns null if the file is missing, corrupt, or has an unknown state.
 */
export async function readStatus(projectDir: string): Promise<StatusFile | null> {
  const statusPath = join(projectDir, 'status.local.json');
  let raw: string;
  try {
    raw = await Bun.file(statusPath).text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isStatusFile(parsed)) return null;
  return parsed;
}

/**
 * Returns the set of cwds from the provided list that have a live Claude
 * process running in them.
 *
 * Detection strategy:
 *   1. `pgrep -a claude` — standard installs
 *   2. `/proc/<pid>/exe` symlinks containing `.claude-wrapped` — NixOS wrapping
 */
// REVIEW: code-correctness-reviewer - The liveness cache stores ONLY the cwds that were live among the `cwds` passed by the FIRST caller within the 2.5s TTL. When `buildProjectState` is called concurrently for N projects via `Promise.all`, each calls `checkLiveness([project.cwd])` with its own single cwd. The first call to miss the cache (cache cold) scans all PIDs but only records cwds matching its single-element input. All subsequent concurrent callers within the TTL receive that partial result. A project running in `/home/user/projB` will be shown as stopped if the cache was primed by `/home/user/projA`'s call first. Fix: the cache should either store ALL live cwds (scan /proc unconditionally and collect all cwds, returning the full live set), or `buildProjectState` should pass all cwds at once instead of one at a time.
export async function checkLiveness(cwds: string[]): Promise<Set<string>> {
  if (cwds.length === 0) return new Set();

  if (livenessCache !== null && Date.now() - livenessCache.ts < 2500) {
    return livenessCache.result;
  }

  const pids = new Set<number>();
  collectPgrepPids(pids);
  await collectProcExePids(pids);

  if (pids.size === 0) {
    livenessCache = { result: new Set(), ts: Date.now() };
    return livenessCache.result;
  }

  const cwdSet = new Set(cwds);
  const live = new Set<string>();

  await Promise.all(
    [...pids].map(async (pid) => {
      const procCwd = await readProcCwd(pid);
      if (procCwd !== null && cwdSet.has(procCwd)) {
        live.add(procCwd);
      }
    }),
  );

  livenessCache = { result: live, ts: Date.now() };
  return live;
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
    // REVIEW: code-correctness-reviewer - `split('/').pop()` is inconsistent with `basename()` used elsewhere; for edge-case paths (e.g. trailing slash, empty string) this can produce unexpected results (empty string or undefined). Since `basename` is already imported and handles all POSIX edge cases, prefer `basename(changedProjectDir)` here.
    const dirName = changedProjectDir.split('/').pop() ?? '';
    const info = await readProjectInfo(changedProjectDir, dirName);
    if (info !== null) {
      const updatedState = await buildProjectState(info, claudeDir);
      projectStateCache.set(changedProjectDir, updatedState);
    } else {
      // Project disappeared — remove from cache.
      projectStateCache.delete(changedProjectDir);
    }
    return [...projectStateCache.values()];
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

  projectStateCache.clear();
  for (let i = 0; i < projects.length; i++) {
    const fullPath = join(claudeDir, projects[i].projectDir);
    projectStateCache.set(fullPath, states[i]);
  }

  return states;
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
  if (maxInactivityHours <= 0 || !isFinite(maxInactivityHours)) return projects;
  const cutoff = Date.now() - maxInactivityHours * 3600 * 1000;
  return projects.filter((p) => {
    if (p.lastUpdated === null) return false;
    // REVIEW: code-correctness-reviewer - If `p.lastUpdated` is not a valid date string, `getTime()` returns NaN and `NaN >= cutoff` is false, silently filtering out the project as stale. A malformed timestamp would cause a valid active project to disappear from the dashboard. Consider validating the date or using a fallback to 0.
    return new Date(p.lastUpdated).getTime() >= cutoff;
  });
}

/**
 * Counts active sub-agent JSONL files in {sessionDir}/subagents/ where
 * mtime is within the last 5 minutes. Returns 0 if dir doesn't exist.
 */
// REVIEW: code-style-reviewer - `countActiveSubagents` is exported but has no production callers — only tests call it. `buildProjectState` uses `getSubagentInfos` and derives `subagentCount` from that. Exporting an unused function as part of the public API adds unnecessary maintenance surface. Consider removing it (and its tests) or inlining it as a test helper if the count-only behavior is still needed for testing.
// REVIEW: architecture-reviewer - `countActiveSubagents` duplicates the directory enumeration and mtime-threshold logic already present in `getSubagentInfos`. Since `buildProjectState` calls `getSubagentInfos` and derives `subagentCount` from the result, `countActiveSubagents` appears to be dead code (no callers in the codebase). If it is no longer called, remove it; if it still has external callers, refactor it to delegate to `getSubagentInfos` to avoid the logic duplication.
export async function countActiveSubagents(latestJSONL: string): Promise<number> {
  // Strip .jsonl extension to get the session dir
  const sessionDir = latestJSONL.endsWith('.jsonl')
    ? latestJSONL.slice(0, -'.jsonl'.length)
    : latestJSONL;
  const subagentsDir = join(sessionDir, 'subagents');
  const cutoff = Date.now() - SUBAGENT_ACTIVE_THRESHOLD_MS;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.name.endsWith('.jsonl')) return;
      try {
        const s = await stat(join(subagentsDir, entry.name));
        if (s.mtimeMs > cutoff) count++;
      } catch {
        // skip unreadable files
      }
    }),
  );

  return count;
}

/**
 * Returns SubagentInfo for every sub-agent JSONL found in {sessionDir}/subagents/.
 * Each entry includes enrichment data from readSessionTail plus identity fields
 * (agentId, jsonlPath, isActive, optional slug). Returns [] if the dir is absent.
 */
export async function getSubagentInfos(latestJSONL: string): Promise<SubagentInfo[]> {
  // REVIEW: code-style-reviewer - The `.jsonl` extension stripping logic is identical in `countActiveSubagents` and here. Extract a private `sessionDirFromJSONL(path: string): string` helper to avoid the duplication and centralize the convention.
  const sessionDir = latestJSONL.endsWith('.jsonl')
    ? latestJSONL.slice(0, -'.jsonl'.length)
    : latestJSONL;
  const subagentsDir = join(sessionDir, 'subagents');
  const cutoff = Date.now() - SUBAGENT_ACTIVE_THRESHOLD_MS;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonlEntries = entries.filter((e) => e.name.endsWith('.jsonl'));

  // Read parent session tail once to get the agentDescriptions map; zero extra I/O
  // since readSessionTail caches by path and is called again in buildProjectState.
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
      const nameWithout = entry.name.slice(0, -'.jsonl'.length);
      const agentId = nameWithout.startsWith('agent-')
        ? nameWithout.slice('agent-'.length)
        : nameWithout;

      const isActive = mtimeMs > cutoff;

      // Exclude completed agents older than 5 minutes to keep payload lean.
      if (!isActive && mtimeMs < expiryCutoff) return null;

      const enrichment = await readSessionTail(jsonlPath);

      // Optionally read slug from first line (best-effort)
      let slug: string | undefined;
      try {
        const file = Bun.file(jsonlPath);
        const text = await file.slice(0, 512).text();
        const firstLine = text.split('\n')[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine) as Record<string, unknown>;
          if (typeof parsed.slug === 'string') slug = parsed.slug;
        }
      } catch {
        // slug is optional — ignore errors
      }

      const lastMessageTime = new Date(mtimeMs).toISOString();
      const description = parentTail.agentDescriptions.get(agentId);
      // REVIEW: code-style-reviewer - `launchTime` is set to the same value as `lastMessageTime` (both derived from `mtimeMs`). The comment on `SubagentInfo.launchTime` says "from file mtime (used as proxy for launch time)" — this means they will always be identical, so sorting by `launchTime` is equivalent to sorting by `lastMessageTime`. If a better launch time signal (e.g. first JSONL entry timestamp) is planned, tracking `launchTime` as a separate variable here is premature until that is implemented. If mtime is permanently the proxy, consider removing the duplicate field and using `lastMessageTime` for ordering.
      // REVIEW: code-correctness-reviewer - `launchTime` is set to `mtimeMs` (last modification time), but R43.1 specifies "from first JSONL entry or file mtime". Using mtime as `launchTime` sorts sub-agents by when they last wrote, not when they started. A long-running agent that started early but finished last would appear first. The first-line timestamp is already read above (for `slug`) — extracting `timestamp` from that same first line and using it as `launchTime` would correctly implement R43.1.
      return { agentId, slug, description, jsonlPath, isActive, lastMessageTime, launchTime: lastMessageTime, ...enrichment };
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
// REVIEW: code-style-reviewer - `readSessionTail` is ~250 lines long and does at least three distinct things: cache/delta management, forward scan for tasks, and reversed scan for enrichment + merge. Functions should be short and focused on one thing. Consider extracting: (1) a `computeReadRange()` helper for offset/baseData logic; (2) a `scanReversed()` helper for the reversed enrichment pass; (3) a `mergeEnrichment()` helper for the merge step. This would also make `scanTaskCreateUpdate` and `scanTodoWrite` more clearly peers at the same abstraction level.
export async function readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
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

  // Determine read range and base data to merge into.
  let startOffset: number;
  let baseData: SessionTailInfo;
  // isDelta tracks whether startOffset is exactly at a line boundary (append-only delta).
  // When true, the first line at startOffset is complete and must NOT be discarded.
  let isDelta: boolean;
  if (cached !== undefined && cached.mtime === mtimeMs && cached.fileSize === size) {
    // Nothing changed — return cached result immediately.
    return cached.data;
  } else if (cached !== undefined && size > cached.fileSize) {
    // Delta read: only parse the new bytes appended since last read.
    // Applies even when mtime appears unchanged (sub-second writes on fast systems).
    startOffset = cached.fileSize;
    // REVIEW: code-style-reviewer - The comment says "share the agentDescriptions map reference" but `new Map(...)` creates a copy, not a shared reference. The comment is misleading — the actual intent is to copy the cached data so new scan results can be accumulated independently without mutating the cached entry. Fix the comment to reflect what actually happens.
    baseData = { ...cached.data, agentDescriptions: new Map(cached.data.agentDescriptions) };
    isDelta = true;
  } else {
    // Full read (first read, file shrank, or mtime changed without size growth).
    startOffset = Math.max(0, size - MAX_FIRST_READ);
    baseData = { agentDescriptions: new Map() };
    isDelta = false;
  }

  let text: string;
  try {
    const file = Bun.file(jsonlPath);
    text = await file.slice(startOffset).text();
  } catch {
    return { agentDescriptions: new Map() };
  }

  let lines = text.split('\n').filter((l) => l.trim() !== '');

  // Discard the first line when starting at a cap-based offset (may be a partial line).
  // In delta mode startOffset is at a line boundary, so no discard is needed.
  if (!isDelta && startOffset > 0 && lines.length > 0) {
    lines = lines.slice(1);
  }

  // Forward pass: scan for TaskCreate/TaskUpdate tool calls to build task map.
  // Must run forward (chronological order) so TaskCreate then TaskUpdate patch correctly.
  const scannedTasks = scanTaskCreateUpdate(lines);

  // Scan newest-to-oldest so "first found" = most recent.
  // Token counts are accumulated across ALL assistant entries in the scanned range.
  // agentDescriptions are accumulated across ALL queue-operation enqueue entries.
  const reversed = lines.slice().reverse();
  const scanResult: SessionTailInfo = { agentDescriptions: new Map() };
  let foundUserActivity = false;
  let foundAssistantActivity = false;
  let foundModel = false;
  // REVIEW: code-correctness-reviewer - `scannedTasks !== null` is true even when the returned Map is empty (foundAny=true because a TaskCreate tool_use was seen but its matching tool_result fell outside the scanned window, or only TaskUpdate blocks with no preceding creates were found). This suppresses the TodoWrite fallback even when zero tasks were resolved. Fix: `(scannedTasks !== null && scannedTasks.size > 0) || baseData.tasks !== undefined`.
  // foundTasks is true when tasks came from TaskCreate/TaskUpdate (new scan or cached base).
  // When true, skip the TodoWrite fallback in the reversed scan.
  let foundTasks = scannedTasks !== null || baseData.tasks !== undefined;
  // inputTokens uses last-seen value (cache_read grows monotonically per session).
  // First assistant entry in reversed scan = last chronologically = the value to use.
  let scanInputTokens: number | undefined;
  let scanOutputTokens = 0;

  for (const line of reversed) {
    // Don't break early even when other fields are found — need to accumulate output tokens.
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry.type;
    const message = entry.message as Record<string, unknown> | undefined;

    if (type === 'user') {
      if (!message || foundUserActivity) continue;
      const content = message.content;
      if (typeof content === 'string') {
        // Try command first (content starting with < may carry <command-name> tag).
        const cmd = content.startsWith('<') ? extractCommand(content) : null;
        if (cmd !== null) {
          scanResult.latestUserActivity = { text: cmd, isCommand: true };
          foundUserActivity = true;
        } else if (!content.startsWith('<')) {
          // Plain user message — exclude <-prefixed content that isn't a command.
          scanResult.latestUserActivity = { text: content.slice(0, 200), isCommand: false };
          foundUserActivity = true;
        }
      }
    }

    if (type === 'assistant' && message) {
      if (!foundModel && typeof message.model === 'string') {
        scanResult.model = message.model;
        foundModel = true;
      }

      // input tokens: last-seen value wins (cache_read_input_tokens is the entire cached context
      // per call, so it grows monotonically — summing gives a wildly inflated number).
      // output tokens: accumulate all (per-call deltas, correct to sum).
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage !== undefined) {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
        // Only take the first encountered (= last chronologically) for input.
        if (scanInputTokens === undefined) scanInputTokens = input + cacheCreate + cacheRead;
        if (typeof usage.output_tokens === 'number') scanOutputTokens += usage.output_tokens;
      }

      if (Array.isArray(message.content)) {
        const contentBlocks = message.content as unknown[];

        // Only fall back to TodoWrite when no TaskCreate/TaskUpdate tasks were found.
        if (!foundTasks) {
          scanTodoWrite(contentBlocks, scanResult);
          if (scanResult.tasksTotal !== undefined) foundTasks = true;
        }

        // First assistant entry in reversed scan (= most recent chronologically) sets
        // latestAssistantActivity. Both text and tool are extracted independently from
        // the same entry — an entry may have text only, tool only, or both.
        if (!foundAssistantActivity) {
          const textBlock = contentBlocks.find(
            (b): b is { type: string; text: string } =>
              typeof b === 'object' &&
              b !== null &&
              (b as Record<string, unknown>).type === 'text' &&
              typeof (b as Record<string, unknown>).text === 'string',
          );
          const toolUse = contentBlocks.find(
            (item): item is { type: string; name: string } =>
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'tool_use' &&
              typeof (item as Record<string, unknown>).name === 'string',
          );
          if (textBlock !== undefined || toolUse !== undefined) {
            scanResult.latestAssistantActivity = {
              text: textBlock ? textBlock.text.slice(0, 200) : undefined,
              tool: toolUse ? toolUse.name : undefined,
            };
            foundAssistantActivity = true;
          }
        }
      }
    }

    // progress entries carry TodoWrite tool calls (legacy fallback path).
    if (!foundTasks && type === 'progress') {
      const data = entry.data as Record<string, unknown> | undefined;
      const outerMsg = data?.message as Record<string, unknown> | undefined;
      const innerMsg = outerMsg?.message as Record<string, unknown> | undefined;
      const content = innerMsg?.content;
      if (Array.isArray(content)) {
        scanTodoWrite(content as unknown[], scanResult);
        if (scanResult.tasksTotal !== undefined) foundTasks = true;
      }
    }

    // queue-operation enqueue entries map agentId → description for sub-agents.
    if (type === 'queue-operation') {
      const operation = entry.operation;
      if (operation === 'enqueue' && typeof entry.content === 'string') {
        try {
          const parsed = JSON.parse(entry.content) as Record<string, unknown>;
          if (typeof parsed.task_id === 'string' && typeof parsed.description === 'string') {
            scanResult.agentDescriptions.set(parsed.task_id, parsed.description);
          }
        } catch {
          // malformed content — skip
        }
      }
    }
  }

  if (scanInputTokens !== undefined && scanInputTokens > 0) scanResult.inputTokens = scanInputTokens;
  if (scanOutputTokens > 0) scanResult.outputTokens = scanOutputTokens;

  // Merge task data: start from base tasks then apply new scan's creates/updates.
  // This ensures delta reads accumulate all tasks across the session's history.
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
    const nonDeleted = taskList.filter((t) => t.status !== 'deleted');
    mergedTasksTotal = nonDeleted.length;
    mergedTasksDone = nonDeleted.filter((t) => t.status === 'completed').length;
    // Propagate to scanResult so foundTasks check works for TodoWrite fallback path.
    scanResult.tasks = mergedTasks;
    scanResult.tasksTotal = mergedTasksTotal;
    scanResult.tasksDone = mergedTasksDone;
  } else if (foundTasks) {
    // TodoWrite path: scanResult already has tasksDone/tasksTotal set.
    mergedTasksDone = scanResult.tasksDone;
    mergedTasksTotal = scanResult.tasksTotal;
  } else {
    mergedTasksDone = baseData.tasksDone;
    mergedTasksTotal = baseData.tasksTotal;
    mergedTasks = baseData.tasks;
  }

  // Merge: new scan results override baseData for "latest wins" fields.
  // inputTokens: last-wins (new scan replaces base, not additive), since the value
  //   represents the most-recent API call's cached context size.
  // outputTokens: additive across delta reads (per-call deltas that should be summed).
  // agentDescriptions accumulate: merge scan entries into the base map.
  const mergedInputTokens = scanResult.inputTokens ?? baseData.inputTokens;
  const mergedOutputTokens = (baseData.outputTokens ?? 0) + (scanResult.outputTokens ?? 0);

  const mergedDescriptions = baseData.agentDescriptions;
  for (const [id, desc] of scanResult.agentDescriptions) {
    mergedDescriptions.set(id, desc);
  }

  const merged: SessionTailInfo = {
    latestUserActivity: scanResult.latestUserActivity ?? baseData.latestUserActivity,
    latestAssistantActivity: scanResult.latestAssistantActivity ?? baseData.latestAssistantActivity,
    model: scanResult.model ?? baseData.model,
    tasks: mergedTasks,
    tasksDone: mergedTasksDone,
    tasksTotal: mergedTasksTotal,
    inputTokens: mergedInputTokens !== undefined && mergedInputTokens > 0 ? mergedInputTokens : undefined,
    outputTokens: mergedOutputTokens > 0 ? mergedOutputTokens : undefined,
    agentDescriptions: mergedDescriptions,
  };

  // Strip undefined keys to keep the object clean (except agentDescriptions which is always present).
  for (const key of Object.keys(merged) as (keyof SessionTailInfo)[]) {
    if (key !== 'agentDescriptions' && merged[key] === undefined) delete merged[key];
  }

  sessionTailCache.set(jsonlPath, { mtime: mtimeMs, fileSize: size, data: merged });
  return merged;
}

// ─── Exported Test Helpers ───────────────────────────────────────────────────

/**
 * Resets all module-level caches. Only call from tests.
 */
// REVIEW: architecture-reviewer - Exporting test infrastructure (`_resetCachesForTesting`) through the public module API is an architectural anti-pattern. It leaks internal implementation details and makes the test surface part of the contract. The underscore prefix is a weak convention signal that this is test-only; TypeScript has no enforcement. This need disappears if caches are encapsulated in a class/factory instance (see the module-level caches comment above): tests simply instantiate a fresh store.
export function _resetCachesForTesting(): void {
  livenessCache = null;
  sessionsIndexCache.clear();
  sessionTailCache.clear();
  projectStateCache.clear();
}

/**
 * Parses pgrep -a output lines ("PID command ...") and returns the list of PIDs.
 * Exported for unit testing.
 */
export function parseProcessOutput(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    const pidStr = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) pids.push(pid);
  }
  return pids;
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/**
 * Extracts a slash command string from a user message content string.
 * Returns "/command-name [args]" if a <command-name> tag is found, null otherwise.
 */
function extractCommand(content: string): string | null {
  const nameMatch = content.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  const argsMatch = content.match(/<command-args>([^<]*)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : '';
  return args ? `${name} ${args}` : name;
}

/**
 * Forward-scans JSONL lines for TaskCreate/TaskUpdate tool_use blocks.
 * Returns a Map<taskId, TaskInfo> if any TaskCreate blocks were found, null otherwise.
 * IDs are extracted from the tool_result response text ("Task #N created successfully").
 * TaskUpdate patches status and optionally subject/activeForm on existing entries.
 */
function scanTaskCreateUpdate(lines: string[]): Map<string, TaskInfo> | null {
  // Maps tool_use_id → { subject, activeForm } for pending TaskCreate calls awaiting tool_result.
  const pendingCreates = new Map<string, { subject: string; activeForm?: string }>();
  const tasks = new Map<string, TaskInfo>();
  let foundAny = false;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = entry.type;
    const message = entry.message as Record<string, unknown> | undefined;

    if (type === 'assistant' && message && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;
        if (typeof b.id !== 'string') continue;
        const input = b.input as Record<string, unknown> | undefined;
        if (!input) continue;

        if (b.name === 'TaskCreate' && typeof input.subject === 'string') {
          // Record pending create keyed by tool_use_id to match tool_result later.
          pendingCreates.set(b.id, {
            subject: input.subject,
            activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
          });
          foundAny = true;
        }

        if (b.name === 'TaskUpdate' && typeof input.taskId === 'string') {
          const existing = tasks.get(input.taskId);
          if (existing) {
            if (typeof input.status === 'string') existing.status = input.status;
            if (typeof input.subject === 'string') existing.subject = input.subject;
            if (typeof input.activeForm === 'string') existing.activeForm = input.activeForm;
          }
          // REVIEW: code-correctness-reviewer - `foundAny = true` is set unconditionally for TaskUpdate, even when `existing` is undefined (the task was not found in the map, e.g. its TaskCreate tool_result was in a truncated portion of a large file). This means a TaskUpdate-only scan sets `foundAny=true` and returns a non-null empty Map, which — combined with the `foundTasks` check — suppresses the TodoWrite fallback even though no tasks were actually resolved. Only set `foundAny = true` when the update was actually applied: `if (existing) { ...; foundAny = true; }`.
          foundAny = true;
        }
      }
    }

    // User messages carry tool_result blocks that confirm TaskCreate with the assigned ID.
    if (type === 'user' && message && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        if (typeof b.tool_use_id !== 'string') continue;

        const pending = pendingCreates.get(b.tool_use_id);
        if (!pending) continue;

        // Extract task ID from result text like "Task #3 created successfully"
        let taskId: string | undefined;
        const content = b.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as unknown[])
                .filter((c): c is { type: string; text: string } =>
                  typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
                .map((c) => c.text)
                .join('')
            : '';
        const match = text.match(/Task #(\d+)/i);
        if (match) taskId = match[1];

        if (taskId) {
          tasks.set(taskId, { id: taskId, subject: pending.subject, status: 'pending', activeForm: pending.activeForm });
          pendingCreates.delete(b.tool_use_id);
        }
      }
    }
  }

  return foundAny ? tasks : null;
}

function scanTodoWrite(contentBlocks: unknown[], result: SessionTailInfo): void {
  const todoWrite = contentBlocks.find(
    (item): item is { type: string; name: string; input: Record<string, unknown> } =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).type === 'tool_use' &&
      (item as Record<string, unknown>).name === 'TodoWrite',
  );
  if (todoWrite === undefined) return;
  const input = (todoWrite as Record<string, unknown>).input as Record<string, unknown> | undefined;
  if (input === undefined || !Array.isArray(input.todos)) return;
  const todos = input.todos as Array<{ status: string }>;
  result.tasksTotal = todos.length;
  result.tasksDone = todos.filter((t) => t.status === 'completed').length;
}

async function buildProjectState(project: ProjectInfo, claudeDir: string): Promise<ProjectState> {
  const projectDirPath = join(claudeDir, project.projectDir);
  const status = await readStatus(projectDirPath);
  const liveCwds = await checkLiveness([project.cwd]);
  const state = resolveState(project.cwd, status, liveCwds);

  let lastUpdated: string | null = status?.timestamp ?? null;
  if (lastUpdated === null) {
    try {
      const mtimeStat = await stat(project.latestJSONL);
      lastUpdated = new Date(mtimeStat.mtimeMs).toISOString();
    } catch {
      // leave as null if stat fails
    }
  }

  const base: ProjectState = { ...project, state, lastUpdated };

  // Fetch enrichment for all states so stopped sessions still show messages/tokens/tasks.
  // Sub-agents are only relevant for active sessions.
  const tail = await readSessionTail(project.latestJSONL);
  const subagents = state !== 'stopped' ? await getSubagentInfos(project.latestJSONL) : [];
  const subagentCount = subagents.filter((s) => s.isActive).length;
  // REVIEW: code-correctness-reviewer - `notificationMessage` and `notificationTimestamp` from `status` (StatusFile) are never propagated to the returned `ProjectState`. `ProjectState` also doesn't declare these fields. The UI checks `proj.notificationTimestamp` to trigger the notification flash (R26), but this will always be `undefined`, making the notification flash feature completely non-functional. Fix: add `notificationMessage?: string` and `notificationTimestamp?: string` to `ProjectState` and forward them here: `notificationMessage: status?.notificationMessage, notificationTimestamp: status?.notificationTimestamp`.
  return {
    ...base,
    latestUserActivity: tail.latestUserActivity,
    latestAssistantActivity: tail.latestAssistantActivity,
    model: tail.model,
    tasksDone: tail.tasksDone,
    tasksTotal: tail.tasksTotal,
    inputTokens: tail.inputTokens,
    outputTokens: tail.outputTokens,
    subagents: subagents.length > 0 ? subagents : undefined,
    subagentCount: subagentCount > 0 ? subagentCount : undefined,
    gitBranch: project.gitBranch,
  };
}

async function readProjectInfo(fullPath: string, dirName: string): Promise<ProjectInfo | null> {
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
    const latest = index.entries.reduce((a, b) => (a.fileMtime > b.fileMtime ? a : b));
    return {
      projectDir: dirName,
      cwd: index.projectPath,
      projectName: basename(index.projectPath),
      sessionId: latest.sessionId,
      latestJSONL: latest.fullPath,
      summary: latest.summary,
      firstPrompt: latest.firstPrompt,
      messageCount: latest.messageCount,
      sessionModified: latest.modified,
      gitBranch: latest.gitBranch,
    };
  }

  const latestJSONL = await findLatestJSONL(fullPath);
  if (latestJSONL === null) return null;

  const firstLine = readFirstLine(latestJSONL);
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
    if (!entry.endsWith('.jsonl')) continue;
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

// REVIEW: architecture-reviewer - `readFirstLine` uses synchronous `readFileSync` while the rest of the file uses exclusively async I/O (`Bun.file().text()`, `stat`, etc.). This blocks the event loop when reading the first line of a JSONL fallback path. The inconsistency is also a maintenance footfall — it imports `readFileSync` from `node:fs` solely for this function. Prefer an async implementation using `Bun.file(filePath).slice(0, N).text()` (same pattern used for slug reading in `getSubagentInfos`) and remove the `readFileSync` import.
function readFirstLine(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const newline = content.indexOf('\n');
    return newline === -1 ? content.trim() : content.slice(0, newline).trim();
  } catch {
    return null;
  }
}

function collectPgrepPids(pids: Set<number>): void {
  try {
    const result = Bun.spawnSync(['pgrep', '-a', 'claude'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // pgrep exits 1 when no matches — that is not an error
    if (result.stdout) {
      const output = new TextDecoder().decode(result.stdout);
      for (const pid of parseProcessOutput(output)) {
        pids.add(pid);
      }
    }
  } catch {
    // pgrep not available — ignore
  }
}

async function collectProcExePids(pids: Set<number>): Promise<void> {
  let procEntries: string[];
  try {
    procEntries = await readdir('/proc');
  } catch {
    return;
  }

  await Promise.all(
    procEntries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = parseInt(entry, 10);
      if (pids.has(pid)) return; // already found via pgrep
      try {
        const exeLink = await readlink(`/proc/${pid}/exe`);
        if (exeLink.includes('.claude-wrapped')) {
          pids.add(pid);
        }
      } catch {
        // process may have exited or we lack permissions
      }
    }),
  );
}

async function readProcCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function resolveState(
  cwd: string,
  status: StatusFile | null,
  liveCwds: Set<string>,
): SessionState {
  if (status === null) return 'stopped';

  // REVIEW: code-correctness-reviewer - If `status.timestamp` is not a valid date string, `new Date(...).getTime()` returns NaN. `Date.now() - NaN` is NaN, and `NaN > STALE_THRESHOLD_MS` is false, so the staleness check is silently bypassed and the status is treated as perpetually fresh. An invalid timestamp should be treated as stale. Fix: add `isNaN(age) || age > STALE_THRESHOLD_MS`.
  const age = Date.now() - new Date(status.timestamp).getTime();
  if (age > STALE_THRESHOLD_MS && status.state !== 'stopped') return 'stopped';

  // Status is fresh — verify a live process exists for non-stopped states
  if (status.state !== 'stopped' && !liveCwds.has(cwd)) return 'stopped';

  return status.state;
}

function isStatusFile(v: unknown): v is StatusFile {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.state === 'string' &&
    VALID_STATES.has(obj.state) &&
    typeof obj.timestamp === 'string' &&
    typeof obj.session_id === 'string' &&
    typeof obj.working_dir === 'string'
  );
}

function isFirstLineRecord(v: unknown): v is { cwd: string; sessionId: string } {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.cwd === 'string' && typeof obj.sessionId === 'string';
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
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) return false;
  return obj.entries.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Record<string, unknown>).sessionId === 'string' &&
      typeof (e as Record<string, unknown>).fullPath === 'string' &&
      typeof (e as Record<string, unknown>).fileMtime === 'number' &&
      typeof (e as Record<string, unknown>).projectPath === 'string' &&
      typeof (e as Record<string, unknown>).isSidechain === 'boolean',
  );
}
