import type { ServerWebSocket } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectState, filterStaleProjects } from './sessions';
import type { ProjectState } from './sessions';
import { DEFAULT_CONFIG } from './config';
import { watchForChanges } from './watcher';

// REVIEW: architecture-reviewer - `DEFAULT_CLAUDE_DIR` is defined here again as a module-level constant using a different template-literal style, while `sessions.ts` constructs the same path via `join()`. Two sources of truth for the same default path will diverge under refactoring. Extract this constant to a shared location (e.g., a `constants.ts` or export it from `sessions.ts`) and import it here.
// REVIEW: code-style-reviewer - `DEFAULT_CLAUDE_DIR` is constructed with a template literal here while `sessions.ts` uses `join()` for the same path. Inconsistent path construction style across modules: prefer `join()` everywhere for proper cross-platform separators and consistency.
const DEFAULT_CLAUDE_DIR = `${Bun.env.HOME ?? '/root'}/.claude/projects`;

export interface ServerOptions {
  port?: number;
  hostname?: string;
  claudeDir?: string;
  maxInactivityHours?: number;
}

/**
 * Starts the HTTP + WebSocket server.
 * Returns the actual port (useful when port 0 is passed for OS assignment), a stop function,
 * and a `ready` promise that resolves after the initial state map scan completes.
 */
export function startServer(options: ServerOptions = {}): { port: number; stop: () => void; ready: Promise<void> } {
  const port = options.port ?? DEFAULT_CONFIG.port;
  const hostname = options.hostname ?? DEFAULT_CONFIG.host;
  const claudeDir = options.claudeDir ?? DEFAULT_CLAUDE_DIR;
  const maxInactivityHours = options.maxInactivityHours ?? DEFAULT_CONFIG.maxInactivityHours;

  // REVIEW: architecture-reviewer - The HTML asset is loaded from a relative path using `import.meta.dir` and `readFileSync` at call time rather than being bundled or embedded. This creates a runtime dependency on the file system layout: if `startServer` is called from a different working directory or after the `public/` directory is relocated, it silently crashes. The `readFileSync` at call time also blocks the event loop during startup. Consider embedding the HTML at build time (Bun supports `Bun.file` with `import.meta.dir` at module load time), or at minimum move the read to module initialization so failures are detected early rather than mid-request.
  const htmlPath = join(import.meta.dir, '..', 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  const clients = new Set<ServerWebSocket<unknown>>();

  // Server-owned state map: projectDir (full path) → ProjectState.
  // Populated on startup, updated by watcher events. WS open and /api/state
  // read directly from here — no on-demand rescans.
  const stateMap = new Map<string, ProjectState>();

  // Pending running→stopped debounce timers: projectDir → timeout handle.
  // When a watcher event computes stopped for a previously-running project, we
  // wait 3s and re-check rather than updating the map immediately. This
  // prevents transient flicker from brief pgrep misses or stale status files.
  const stopDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function currentFilteredState(): ProjectState[] {
    return filterStaleProjects([...stateMap.values()], maxInactivityHours);
  }

  function broadcastCurrent(): void {
    if (clients.size === 0) return;
    const payload = JSON.stringify(currentFilteredState());
    for (const ws of clients) {
      ws.send(payload);
    }
  }

  async function updateProject(changedProjectDir: string): Promise<void> {
    const newStates = await getProjectState(claudeDir, changedProjectDir);

    // Find the updated project state from the rescan result.
    const updatedState = newStates.find((s) => {
      const fullPath = join(claudeDir, s.projectDir);
      return fullPath === changedProjectDir;
    });

    if (updatedState === undefined) {
      // Project disappeared — remove immediately.
      stateMap.delete(changedProjectDir);
      broadcastCurrent();
      return;
    }

    const prevState = stateMap.get(changedProjectDir);
    const prevSessionState = prevState?.state;
    const newSessionState = updatedState.state;

    // R33: Hysteresis for running→stopped transitions.
    // Cancel any in-flight debounce for this project on each watcher event.
    const existing = stopDebounceTimers.get(changedProjectDir);
    if (existing !== undefined) {
      clearTimeout(existing);
      stopDebounceTimers.delete(changedProjectDir);
    }

    if (prevSessionState === 'running' && newSessionState === 'stopped') {
      // Delay the map update by 3s and re-check to avoid transient flicker.
      const timer = setTimeout(() => {
        stopDebounceTimers.delete(changedProjectDir);
        getProjectState(claudeDir, changedProjectDir)
          .then((recheckStates) => {
            const recheckState = recheckStates.find((s) => {
              const fullPath = join(claudeDir, s.projectDir);
              return fullPath === changedProjectDir;
            });
            if (recheckState === undefined) {
              stateMap.delete(changedProjectDir);
            } else {
              stateMap.set(changedProjectDir, recheckState);
            }
            broadcastCurrent();
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`ccmon: recheck error: ${msg}\n`);
          });
      }, 3000);
      stopDebounceTimers.set(changedProjectDir, timer);
      // Don't update the map or broadcast yet.
      return;
    }

    stateMap.set(changedProjectDir, updatedState);
    broadcastCurrent();
  }

  const watcher = watchForChanges(claudeDir, (projectDir: string) => {
    updateProject(projectDir).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ccmon: broadcast error: ${msg}\n`);
    });
  });

  // Populate the state map on startup with a full scan.
  const ready = getProjectState(claudeDir)
    .then((states) => {
      stateMap.clear();
      for (const s of states) {
        const fullPath = join(claudeDir, s.projectDir);
        stateMap.set(fullPath, s);
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ccmon: initial scan error: ${msg}\n`);
    });

  const server = Bun.serve({
    port,
    hostname,
    websocket: {
      open(ws) {
        clients.add(ws);
        // Send current map contents — no rescan.
        ws.send(JSON.stringify(currentFilteredState()));
      },
      message(_ws, _data) {
        // clients do not send messages to the server
      },
      close(ws) {
        clients.delete(ws);
      },
    },
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const upgraded = srv.upgrade(req);
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        // upgrade() returns undefined when successful; Response must not be returned
        return undefined;
      }

      if (url.pathname === '/api/state') {
        // Return map contents — no rescan.
        return Promise.resolve(Response.json(currentFilteredState()));
      }

      if (url.pathname === '/') {
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  return {
    port: server.port,
    ready,
    stop(): void {
      for (const timer of stopDebounceTimers.values()) clearTimeout(timer);
      stopDebounceTimers.clear();
      watcher.stop();
      server.stop(true);
    },
  };
}
