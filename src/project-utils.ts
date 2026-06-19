import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { JsonlFirstLine } from "./parsers/claude-jsonl.ts";
import { STATUS_LOG_FILE } from "./session-core.ts";
import {
  CLOSED_PROJECT_TTL_MS,
  MAX_STATUS_LOG_BYTES,
  MS_PER_HOUR,
} from "./timing.ts";
import type { ProjectInfo, ProjectState } from "./types.ts";

export type ClaudeProjectInfo = Extract<ProjectInfo, { source: "claude" }>;

export { CLOSED_PROJECT_TTL_MS, MAX_STATUS_LOG_BYTES };

export const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude", "projects");

const JSONL_EXT = ".jsonl";

/**
 * Mutates projectName on each ProjectState in the array to disambiguate
 * projects that share the same leaf directory name. Expands with parent
 * path segments until unique within the array.
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
): Promise<ClaudeProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(claudeDir);
  } catch {
    return [];
  }

  const results: ClaudeProjectInfo[] = [];

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
  const cutoff = Date.now() - maxInactivityHours * MS_PER_HOUR;
  const closedCutoff = Date.now() - CLOSED_PROJECT_TTL_MS;
  return projects.filter((p) => {
    if (p.lastUpdated === null) return false;
    const time = new Date(p.lastUpdated).getTime();
    if (Number.isNaN(time)) return true;
    if (p.state === "closed") return time >= closedCutoff;
    return time >= cutoff;
  });
}

export function sortProjectsByRecency(
  projects: ProjectState[],
): ProjectState[] {
  return projects.toSorted((a, b) => {
    const updatedA = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    const updatedB = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    if (updatedB !== updatedA) return updatedB - updatedA;

    return a.sessionId.localeCompare(b.sessionId);
  });
}

export async function readProjectInfo(
  fullPath: string,
  dirName: string,
): Promise<ClaudeProjectInfo | null> {
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

export async function findLatestJSONL(dirPath: string): Promise<string | null> {
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

export async function readFirstLine(
  filePath: string,
): Promise<JsonlFirstLine | null> {
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

export function isFirstLineRecord(v: unknown): v is JsonlFirstLine {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.cwd === "string" && typeof obj.sessionId === "string";
}

export function sessionDirFromJSONL(jsonlPath: string): string {
  return jsonlPath.endsWith(JSONL_EXT)
    ? jsonlPath.slice(0, -JSONL_EXT.length)
    : jsonlPath;
}
