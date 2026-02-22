import type { ServerWebSocket } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectState, filterStaleProjects, DEFAULT_CLAUDE_DIR } from './sessions';
import type { ProjectState } from './sessions';
import { DEFAULT_CONFIG } from './config';
import { watchForChanges } from './watcher';

const html = readFileSync(join(import.meta.dir, '..', 'public', 'index.html'), 'utf8');

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
