import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import { collectBackendStates } from "./backends/collect-states";
import type { SessionBackend } from "./backends/types";
import { DEFAULT_CONFIG } from "./config";
import { disambiguateProjectNames, filterStaleProjects } from "./project-utils";
import type { ProjectState } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, "..", "public", "index.html");
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

  const clients = new Set<WebSocket>();

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
    const cloned = filtered.map((p) => ({ ...p }));
    disambiguateProjectNames(cloned);
    return cloned;
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
    const newStates = await collectBackendStates([backend]);
    const keySet = backendToKeys.get(backend);
    if (keySet) {
      for (const key of keySet) {
        stateMap.delete(key);
        backendIndex.delete(key);
      }
      keySet.clear();
    }
    for (const [key, state] of newStates) {
      stateMap.set(key, state);
      backendIndex.set(key, backend);
    }
    backendToKeys.set(backend, new Set(newStates.keys()));
  }

  async function rescanAllBackends(): Promise<void> {
    for (const backend of backends) {
      try {
        await buildStateForBackend(backend);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ccmon: rescan error for backend: ${msg}\n`);
      }
    }
    disambiguateProjectNames([...stateMap.values()]);
  }

  async function rescanBackend(backend: SessionBackend): Promise<void> {
    try {
      await buildStateForBackend(backend);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ccmon: rescan error for backend: ${msg}\n`);
    }
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

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        hostname: osHostname(),
        projects: currentFilteredState(),
      }),
    );
    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFilteredState()));
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  let resolvedPort = port;

  server.listen(port, hostname);

  const ready = new Promise<void>((resolveReady) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolvedPort = addr.port;
      }
      resolveReady();
    });
  }).then(() =>
    rescanAllBackends()
      .then(() => broadcastCurrent())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ccmon: initial scan error: ${msg}\n`);
      }),
  );

  return {
    get port() {
      return resolvedPort;
    },
    ready,
    stop(): void {
      clearInterval(broadcastInterval);
      for (const w of watcherStops) w.stop();
      wss.close();
      server.close();
    },
  };
}
