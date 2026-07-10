import { log } from "../log.ts";
import type { ProjectInfo, ProjectState } from "../types.ts";
import { buildProjectState } from "./build-project-state.ts";
import type { AnySessionBackend, SessionBackend } from "./types.ts";

/**
 * Iterates all backends, scanning projects and building full ProjectState
 * for each, keyed by backend.projectKey(). Returns a single merged Map.
 */
export async function collectBackendStates(
  backends: readonly AnySessionBackend[],
): Promise<Map<string, ProjectState>> {
  const map = new Map<string, ProjectState>();
  for (const backend of backends) {
    if (backend.source === "claude") {
      await collectBackendState(backend, map);
    } else {
      await collectBackendState(backend, map);
    }
  }
  return map;
}

async function collectBackendState<TProjectInfo extends ProjectInfo>(
  backend: SessionBackend<TProjectInfo>,
  map: Map<string, ProjectState>,
): Promise<void> {
  let projects: TProjectInfo[];
  try {
    projects = await backend.scanProjects();
  } catch {
    return;
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
