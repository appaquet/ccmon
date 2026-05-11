import { basename } from "node:path";
import { collectBackendStates } from "../../backends/collect-states.ts";
import { createBackends } from "../../backends/index.ts";
import type { CcmonConfig } from "../../config.ts";
import {
  disambiguateProjectNames,
  filterStaleProjects,
} from "../../project-utils.ts";
import type { ProjectState } from "../../types.ts";

export async function runDump(
  config: CcmonConfig,
  projectFilter: string | null,
): Promise<void> {
  try {
    const { backends, close } = createBackends(config);
    const projectMap = await collectBackendStates(backends);

    const allProjects = [...projectMap.values()];
    disambiguateProjectNames(allProjects);
    const state = filterStaleProjects(allProjects, config.maxInactivityHours);

    if (projectFilter !== null) {
      const match =
        state.find(
          (p) =>
            p.projectName === projectFilter ||
            basename(p.cwd) === projectFilter,
        ) ?? null;
      if (match !== null) {
        console.log(JSON.stringify(match, null, 2));
      }
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
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

  function formatWatchOutput(): string {
    const allProjects = [...projectMap.values()];
    disambiguateProjectNames(allProjects);
    const state = filterStaleProjects(allProjects, config.maxInactivityHours);
    if (projectFilter !== null) {
      const match =
        state.find(
          (p) =>
            p.projectName === projectFilter ||
            basename(p.cwd) === projectFilter,
        ) ?? null;
      return match !== null ? JSON.stringify(match, null, 2) : "";
    }
    return JSON.stringify(state, null, 2);
  }

  try {
    const initial = await collectBackendStates(backends);
    for (const [k, v] of initial) projectMap.set(k, v);
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
        for (const [k, v] of backendStates) projectMap.set(k, v);
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
