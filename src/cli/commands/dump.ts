import { basename } from "node:path";
import { collectBackendStates } from "../../backends/collect-states.ts";
import { createBackends } from "../../backends/index.ts";
import type { SessionBackend } from "../../backends/types.ts";
import type { CcmonConfig } from "../../config.ts";
import {
  disambiguateProjectNames,
  filterStaleProjects,
  sortProjectsByRecency,
} from "../../project-utils.ts";
import type { ProjectState } from "../../types.ts";

export function filterProjectsByName(
  projects: ProjectState[],
  projectFilter: string | null,
): ProjectState[] {
  if (projectFilter === null) return projects;
  return projects.filter(
    (p) => p.projectName === projectFilter || basename(p.cwd) === projectFilter,
  );
}

export function replaceBackendStates(
  projectMap: Map<string, ProjectState>,
  backendProjectKeys: Map<SessionBackend, Set<string>>,
  backend: SessionBackend,
  backendStates: Map<string, ProjectState>,
): void {
  const previousKeys = backendProjectKeys.get(backend) ?? new Set<string>();
  for (const key of previousKeys) {
    if (!backendStates.has(key)) {
      projectMap.delete(key);
    }
  }

  for (const [key, value] of backendStates) {
    projectMap.set(key, value);
  }

  backendProjectKeys.set(backend, new Set(backendStates.keys()));
}

export function buildOutput(
  projects: Iterable<ProjectState>,
  maxInactivityHours: number,
  projectFilter: string | null,
  emitEmptyFilteredSnapshot = false,
): string {
  const allProjects = [...projects];
  disambiguateProjectNames(allProjects);
  const state = sortProjectsByRecency(
    filterStaleProjects(allProjects, maxInactivityHours),
  );
  const matches = filterProjectsByName(state, projectFilter);

  if (projectFilter !== null) {
    if (matches.length > 0 || emitEmptyFilteredSnapshot) {
      return JSON.stringify(matches, null, 2);
    }
    return "";
  }

  return JSON.stringify(state, null, 2);
}

export async function runDump(
  config: CcmonConfig,
  projectFilter: string | null,
): Promise<void> {
  try {
    const { backends, close } = createBackends(config);
    const projectMap = await collectBackendStates(backends);
    const output = buildOutput(
      projectMap.values(),
      config.maxInactivityHours,
      projectFilter,
      false,
    );
    if (output) console.log(output);
    close();
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

export async function runDumpWatch(
  config: CcmonConfig,
  projectFilter: string | null,
): Promise<void> {
  const { backends, close } = createBackends(config);
  const projectMap = new Map<string, ProjectState>();
  const backendProjectKeys = new Map<SessionBackend, Set<string>>();

  function formatWatchOutput(): string {
    return buildOutput(
      projectMap.values(),
      config.maxInactivityHours,
      projectFilter,
      true,
    );
  }

  try {
    for (const backend of backends) {
      const initial = await collectBackendStates([backend]);
      replaceBackendStates(projectMap, backendProjectKeys, backend, initial);
    }
    const output = formatWatchOutput();
    if (output) console.log(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error getting initial state: ${message}\n`);
    process.exit(1);
  }

  const watcherStops: Array<{ stop: () => void }> = [];
  for (const backend of backends) {
    const watcher = backend.watchForChanges(async () => {
      try {
        const backendStates = await collectBackendStates([backend]);
        replaceBackendStates(
          projectMap,
          backendProjectKeys,
          backend,
          backendStates,
        );
        const output = formatWatchOutput();
        if (output) console.log(output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error getting state update: ${message}\n`);
      }
    });
    watcherStops.push(watcher);
  }

  process.on("SIGINT", () => {
    for (const w of watcherStops) w.stop();
    close();
    process.exit(0);
  });
}
