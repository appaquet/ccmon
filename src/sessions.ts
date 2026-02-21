import { readdir, stat, readlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Sub-agents write continuously while active; 45s covers any lag without
// counting finished agents as still running.
const SUBAGENT_ACTIVE_THRESHOLD_MS = 45 * 1000;

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
const sessionTailCache = new Map<string, { mtime: number; data: SessionTailInfo }>();

// Keyed by projectDirPath (full path); holds the most recent ProjectState for each project.
// Populated on a full scan; updated in-place on targeted single-project rescans.
const projectStateCache = new Map<string, ProjectState>();

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionState = 'running' | 'waiting_for_permission' | 'stopped';

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

export interface SessionTailInfo {
  latestUserMessage?: string;
  model?: string;
  lastToolUse?: string;
}

export interface StatusFile {
  state: SessionState;
  timestamp: string;    // ISO 8601
  session_id: string;
  working_dir: string;
}

export interface ProjectState extends ProjectInfo {
  state: SessionState;
  lastUpdated: string | null; // from status file timestamp, null if no status
  // Enrichment fields — only populated for non-stopped sessions
  latestUserMessage?: string;
  subagentCount?: number;
  model?: string;
  lastToolUse?: string;
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
 * Returns null for unrecognized events.
 */
export function mapHookEventToState(hookEvent: string): SessionState | null {
  switch (hookEvent) {
    case 'UserPromptSubmit': return 'running';
    case 'PostToolUse':      return 'running';
    case 'PermissionRequest': return 'waiting_for_permission';
    case 'Stop':             return 'stopped';
    case 'SessionEnd':       return 'stopped';
    default:                 return null;
  }
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
 * Reads the last 64KB of a JSONL session file and extracts enrichment fields
 * by scanning lines from newest to oldest.
 */
export async function readSessionTail(jsonlPath: string): Promise<SessionTailInfo> {
  let mtime: number;
  try {
    const s = await stat(jsonlPath);
    mtime = s.mtimeMs;
  } catch {
    return {};
  }

  const cached = sessionTailCache.get(jsonlPath);
  if (cached !== undefined && cached.mtime === mtime) {
    return cached.data;
  }

  let text: string;
  try {
    const file = Bun.file(jsonlPath);
    const size = file.size;
    const slice = size > 65536 ? file.slice(size - 65536) : file;
    text = await slice.text();
  } catch {
    return {};
  }

  const lines = text.split('\n');
  const result: SessionTailInfo = {};
  let foundUser = false;
  let foundModel = false;
  let foundTool = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (foundUser && foundModel && foundTool) break;

    const line = lines[i].trim();
    if (!line) continue;

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
    if (!message) continue;

    if (!foundUser && type === 'user') {
      const content = message.content;
      if (typeof content === 'string' && !content.startsWith('<')) {
        result.latestUserMessage = content.slice(0, 200);
        foundUser = true;
      }
    }

    if ((!foundModel || !foundTool) && type === 'assistant') {
      if (!foundModel && typeof message.model === 'string') {
        result.model = message.model;
        foundModel = true;
      }

      if (!foundTool && Array.isArray(message.content)) {
        const toolUse = (message.content as unknown[]).find(
          (item): item is { type: string; name: string } =>
            typeof item === 'object' &&
            item !== null &&
            (item as Record<string, unknown>).type === 'tool_use' &&
            typeof (item as Record<string, unknown>).name === 'string',
        );
        if (toolUse) {
          result.lastToolUse = toolUse.name;
          foundTool = true;
        }
      }
    }
  }

  sessionTailCache.set(jsonlPath, { mtime, data: result });
  return result;
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

  if (state !== 'stopped') {
    const [tail, subagentCount] = await Promise.all([
      readSessionTail(project.latestJSONL),
      countActiveSubagents(project.latestJSONL),
    ]);
    return {
      ...base,
      latestUserMessage: tail.latestUserMessage,
      model: tail.model,
      lastToolUse: tail.lastToolUse,
      subagentCount,
      gitBranch: project.gitBranch,
    };
  }

  return base;
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
