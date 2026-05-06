import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { SessionBackend } from "./backends/types";
import { DEFAULT_CONFIG } from "./config";
import type { ProjectState } from "./sessions";
import { disambiguateProjectNames, filterStaleProjects } from "./sessions";

const htmlPath = join(import.meta.dir, "..", "public", "index.html");
let html: string;
try {
  html = readFileSync(htmlPath, "utf8");
} catch {
  throw new Error(`ccmon: public/index.html not found at ${htmlPath}`);
}

export interface ServerOptions {
  port?: number;
  hostname?: string;
  backends: SessionBackend[];
  maxInactivityHours?: number;
  /** Override the periodic broadcast interval in ms. Defaults to 30000. Used in tests only. */
  broadcastIntervalMs?: number;
}

/**
 * Starts the HTTP + WebSocket server.
 * Returns the actual port (useful when port 0 is passed for OS assignment), a stop function,
 * and a `ready` promise that resolves after the initial state map scan completes.
 */
export function startServer(options: ServerOptions): {
  port: number;
  stop: () => void;
  ready: Promise<void>;
} {
  const port = options.port ?? DEFAULT_CONFIG.port;
  const hostname = options.hostname ?? DEFAULT_CONFIG.host;
  const backends = options.backends;
  const maxInactivityHours =
    options.maxInactivityHours ?? DEFAULT_CONFIG.maxInactivityHours;

  const clients = new Set<ServerWebSocket<unknown>>();

  // Per-backend state map: backend.projectKey(project) → ProjectState.
  // Each backend's keys are tracked independently via backendToKeys so a
  // temporary failure in one backend preserves state from healthy backends.
  const stateMap = new Map<string, ProjectState>();
  const backendIndex = new Map<string, SessionBackend>();
  const backendToKeys = new Map<SessionBackend, Set<string>>();

  function currentFilteredState(): ProjectState[] {
    const filtered = filterStaleProjects(
      [...stateMap.values()],
      maxInactivityHours,
    );
    disambiguateProjectNames(filtered);
    return filtered;
  }

  function broadcastCurrent(): void {
    if (clients.size === 0) return;
    const payload = JSON.stringify({
      hostname: osHostname(),
      projects: currentFilteredState(),
    });
    for (const ws of clients) {
      ws.send(payload);
    }
  }

  async function buildStateForBackend(backend: SessionBackend): Promise<void> {
    let projects: Awaited<ReturnType<SessionBackend["scanProjects"]>>;
    try {
      projects = await backend.scanProjects();
    } catch {
      return;
    }

    for (const info of projects) {
      let state: ProjectState;
      try {
        state = await backend.buildProjectState(info);
      } catch {
        continue;
      }
      const key = backend.projectKey(state);
      stateMap.set(key, state);
      backendIndex.set(key, backend);
      let keySet = backendToKeys.get(backend);
      if (!keySet) {
        keySet = new Set();
        backendToKeys.set(backend, keySet);
      }
      keySet.add(key);
    }
  }

  async function rescanAllBackends(): Promise<void> {
    for (const backend of backends) {
      const keySet = backendToKeys.get(backend);
      if (keySet) {
        for (const key of keySet) {
          stateMap.delete(key);
          backendIndex.delete(key);
        }
        backendToKeys.delete(backend);
      }
      await buildStateForBackend(backend);
    }
    disambiguateProjectNames([...stateMap.values()]);
  }

  async function rescanBackend(backend: SessionBackend): Promise<void> {
    const keySet = backendToKeys.get(backend);
    if (keySet) {
      for (const key of keySet) {
        stateMap.delete(key);
        backendIndex.delete(key);
      }
      backendToKeys.delete(backend);
    }

    await buildStateForBackend(backend);
    disambiguateProjectNames([...stateMap.values()]);
  }

  // Periodic safety rescan + broadcast: re-scans from disk and pushes current
  // state every 30 s so clients recover from watcher failures or missed events.
  const BROADCAST_INTERVAL_MS = options.broadcastIntervalMs ?? 30_000;
  const broadcastInterval = setInterval(() => {
    rescanAllBackends()
      .then(() => broadcastCurrent())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ccmon: periodic rescan error: ${msg}\n`);
      });
  }, BROADCAST_INTERVAL_MS);

  // Start watchers for each backend
  const watcherStops: Array<{ stop: () => void }> = [];
  for (const backend of backends) {
    const watcher = backend.watchForChanges(() => {
      rescanBackend(backend)
        .then(() => broadcastCurrent())
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`ccmon: broadcast error: ${msg}\n`);
        });
    });
    watcherStops.push(watcher);
  }

  // Populate the state map on startup
  const ready = rescanAllBackends()
    .then(() => {
      broadcastCurrent();
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
        ws.send(
          JSON.stringify({
            hostname: osHostname(),
            projects: currentFilteredState(),
          }),
        );
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

      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      if (url.pathname === "/api/state") {
        return Response.json(currentFilteredState());
      }

      if (url.pathname === "/") {
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    port: server.port ?? port,
    ready,
    stop(): void {
      clearInterval(broadcastInterval);
      for (const w of watcherStops) w.stop();
      server.stop(true);
    },
  };
}
