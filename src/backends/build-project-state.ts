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

  let enrichment: import("../session-enrichment").SessionEnrichment | undefined;
  try {
    enrichment = await backend.enrichProject(projectInfo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `ccmon: enrichment failed for ${projectInfo.projectName}: ${msg}`,
    );
  }

  let subagents: import("../types").SubagentInfo[] | undefined;
  try {
    const agents =
      state === "running" || state === "waiting_for_permission"
        ? await backend.getSubagents(projectInfo)
        : [];
    subagents = agents;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `ccmon: getSubagents failed for ${projectInfo.projectName}: ${msg}`,
    );
  }
  const subagentCount = subagents?.filter((s) => s.isActive).length ?? 0;

  return {
    ...base,
    ...(enrichment ?? {}),
    subagents: subagents && subagents.length > 0 ? subagents : undefined,
    subagentCount: subagentCount > 0 ? subagentCount : undefined,
  };
}
