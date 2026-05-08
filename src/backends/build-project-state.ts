import type { ProjectInfo, ProjectState } from "../types";
import type { SessionBackend } from "./types";

/**
 * Shared utility that assembles a full ProjectState from a backend using
 * the focused interface methods: resolveState, computeLastUpdated,
 * enrichProject, and getSubagents.
 *
 * Backends that need additional fields (e.g. notification metadata from
 * status events) should call this and spread extra fields on top.
 */
export async function buildProjectState(
  backend: SessionBackend,
  projectInfo: ProjectInfo,
): Promise<ProjectState> {
  const state = await backend.resolveState(projectInfo);
  const lastUpdated = await backend.computeLastUpdated(projectInfo);

  const base: ProjectState = { ...projectInfo, state, lastUpdated };

  const enrichment = await backend.enrichProject(projectInfo);

  const subagents =
    state === "running" || state === "waiting_for_permission"
      ? await backend.getSubagents(projectInfo)
      : [];
  const subagentCount = subagents.filter((s) => s.isActive).length;

  return {
    ...base,
    ...enrichment,
    subagents: subagents.length > 0 ? subagents : undefined,
    subagentCount: subagentCount > 0 ? subagentCount : undefined,
  };
}
