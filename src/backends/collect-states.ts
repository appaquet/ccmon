import { log } from "../log.ts";
import type { ProjectState } from "../types.ts";
import { buildProjectState } from "./build-project-state.ts";
import type { SessionBackend } from "./types.ts";

/**
 * Iterates all backends, scanning projects and building full ProjectState
 * for each, keyed by backend.projectKey(). Returns a single merged Map.
 */
export async function collectBackendStates(
  backends: SessionBackend[],
): Promise<Map<string, ProjectState>> {
  const map = new Map<string, ProjectState>();
  for (const backend of backends) {
    let projects: Awaited<ReturnType<SessionBackend["scanProjects"]>>;
    try {
      projects = await backend.scanProjects();
    } catch {
      continue;
    }
    for (const info of projects) {
      try {
        const state = await buildProjectState(backend, info);
        map.set(backend.projectKey(info), state);
      } catch (err) {
        log.warn("failed to build state", err, { project: info.projectName });
      }
    }
  }
  return map;
}
