import type { ServerWebSocket } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectState, filterStaleProjects, DEFAULT_CLAUDE_DIR } from './sessions';
import type { ProjectState } from './sessions';
import { DEFAULT_CONFIG } from './config';
import { watchForChanges } from './watcher';

const htmlPath = join(import.meta.dir, '..', 'public', 'index.html');
let html: string;
try {
  html = readFileSync(htmlPath, 'utf8');
} catch {
  throw new Error(`ccmon: public/index.html not found at ${htmlPath}`);
}

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
  // REVIEW: architecture-reviewer - The server maintains its own stateMap in addition to the module-level projectStateCache in sessions.ts. These two maps must be kept in sync manually (e.g. the updateProject function calls getProjectState which updates the module cache, then searches the result to update the local stateMap). This is duplicated state management: a bug in either sync path can leave the two maps inconsistent. Consider having the server be the single owner of state or having sessions.ts expose an observable/event-based interface rather than requiring the server to mirror module-level cache updates.
  const stateMap = new Map<string, ProjectState>();

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

    stateMap.set(changedProjectDir, updatedState);
    broadcastCurrent();
  }

  // Watcher reference is set after the initial scan completes to avoid a race where a watcher
  // event fires before ready resolves and then stateMap.clear() discards the interim update.
  let watcher: ReturnType<typeof watchForChanges> | null = null;

  // Populate the state map on startup, then start the watcher so events are never lost.
  const ready = getProjectState(claudeDir)
    .then((states) => {
      stateMap.clear();
      for (const s of states) {
        const fullPath = join(claudeDir, s.projectDir);
        stateMap.set(fullPath, s);
      }
      watcher = watchForChanges(claudeDir, (projectDir: string) => {
        updateProject(projectDir).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`ccmon: broadcast error: ${msg}\n`);
        });
      });
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
        return Response.json(currentFilteredState());
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
      watcher?.stop();
      server.stop(true);
    },
  };
}
