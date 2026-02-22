import { readdir, stat, readlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

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
  latestAssistantMessage?: string;
  lastToolUse?: string;
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
  // Enrichment fields — populated for all states
  latestUserActivity?: { text: string; isCommand: boolean };
  latestAssistantMessage?: string;
  model?: string;
  lastToolUse?: string;
  tasksDone?: number;
  tasksTotal?: number;
  inputTokens?: number;
  outputTokens?: number;
  subagents?: SubagentInfo[];
  // Derived from subagents for backward compatibility
  subagentCount?: number;
}

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
    return new Date(p.lastUpdated).getTime() >= cutoff;
  });
}

/**
 * Counts active sub-agent JSONL files in {sessionDir}/subagents/ where
 * mtime is within the last 5 minutes. Returns 0 if dir doesn't exist.
 */
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
    // Copy shallow fields but share the agentDescriptions map reference so
    // new entries are merged into it in-place below.
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
  let foundAssistant = false;
  let foundModel = false;
  let foundTool = false;
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

        if (!foundTool) {
          const toolUse = contentBlocks.find(
            (item): item is { type: string; name: string } =>
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'tool_use' &&
              typeof (item as Record<string, unknown>).name === 'string',
          );
          if (toolUse) {
            scanResult.lastToolUse = toolUse.name;
            foundTool = true;
          }
        }

        // Only fall back to TodoWrite when no TaskCreate/TaskUpdate tasks were found.
        if (!foundTasks) {
          scanTodoWrite(contentBlocks, scanResult);
          if (scanResult.tasksTotal !== undefined) foundTasks = true;
        }

        if (!foundAssistant) {
          const textBlock = contentBlocks.find(
            (b): b is { type: string; text: string } =>
              typeof b === 'object' &&
              b !== null &&
              (b as Record<string, unknown>).type === 'text' &&
              typeof (b as Record<string, unknown>).text === 'string',
          );
          if (textBlock) {
            scanResult.latestAssistantMessage = textBlock.text.slice(0, 200);
            foundAssistant = true;
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
    latestAssistantMessage: scanResult.latestAssistantMessage ?? baseData.latestAssistantMessage,
    model: scanResult.model ?? baseData.model,
    lastToolUse: scanResult.lastToolUse ?? baseData.lastToolUse,
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
  return {
    ...base,
    latestUserActivity: tail.latestUserActivity,
    latestAssistantMessage: tail.latestAssistantMessage,
    model: tail.model,
    lastToolUse: tail.lastToolUse,
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
