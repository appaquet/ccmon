import { log } from "../log";
import type { NotificationMeta, ProjectInfo, ProjectState } from "../types";
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

  let enrichment: import("../types").SessionEnrichment | undefined;
  try {
    enrichment = await backend.enrichProject(projectInfo);
  } catch (err) {
    log.warn("enrichment failed", err, { project: projectInfo.projectName });
  }

  let subagents: import("../types").SubagentInfo[] | undefined;
  try {
    const agents =
      state === "running" || state === "waiting_for_permission"
        ? await backend.getSubagents(projectInfo)
        : [];
    subagents = agents;
  } catch (err) {
    log.warn("getSubagents failed", err, { project: projectInfo.projectName });
  }
  const subagentCount = subagents?.filter((s) => s.isActive).length ?? 0;

  let notification: NotificationMeta | null = null;
  if (backend.getNotification) {
    try {
      notification = await backend.getNotification(projectInfo);
    } catch (err) {
      log.warn("getNotification failed", err, {
        project: projectInfo.projectName,
      });
    }
  }

  return {
    ...base,
    ...(enrichment ?? {}),
    subagents: subagents && subagents.length > 0 ? subagents : undefined,
    subagentCount: subagentCount > 0 ? subagentCount : undefined,
    ...(notification ?? {}),
  };
}
