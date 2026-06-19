import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname as osHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { collectBackendStates } from "./backends/collect-states.ts";
import type { SessionBackend } from "./backends/types.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { log } from "./log.ts";
import {
  disambiguateProjectNames,
  filterStaleProjects,
  sortProjectsByRecency,
} from "./project-utils.ts";
import { BROADCAST_INTERVAL_MS } from "./timing.ts";
import type { ProjectState } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "..", "public");
const htmlPath = join(publicDir, "index.html");
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

  const backendStates = new Map<SessionBackend, Map<string, ProjectState>>();

  function allStates(): ProjectState[] {
    const states: ProjectState[] = [];
    for (const subMap of backendStates.values()) {
      for (const state of subMap.values()) states.push(state);
    }
    return states;
  }

  function currentFilteredState(): ProjectState[] {
    const filtered = filterStaleProjects(allStates(), maxInactivityHours);
    const cloned = sortProjectsByRecency(filtered).map((p) => ({ ...p }));
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  async function buildStateForBackend(backend: SessionBackend): Promise<void> {
    const newStates = await collectBackendStates([backend]);
    backendStates.set(backend, newStates);
  }

  async function rescanAllBackends(): Promise<void> {
    for (const backend of backends) {
      try {
        await buildStateForBackend(backend);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("rescan error for backend", new Error(msg));
      }
    }
    disambiguateProjectNames(allStates());
  }

  async function rescanBackend(backend: SessionBackend): Promise<void> {
    try {
      await buildStateForBackend(backend);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("rescan error for backend", new Error(msg));
    }
    disambiguateProjectNames(allStates());
  }

  // Periodic safety rescan + broadcast: re-scans from disk and pushes current
  // state every 30 s so clients recover from watcher failures or missed events.
  const broadcastMs = options.broadcastIntervalMs ?? BROADCAST_INTERVAL_MS;
  const broadcastInterval = setInterval(() => {
    rescanAllBackends()
      .then(() => broadcastCurrent())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("periodic rescan error", new Error(msg));
      });
  }, broadcastMs);

  // Start watchers for each backend
  const watcherStops: Array<{ stop: () => void }> = [];
  for (const backend of backends) {
    const watcher = backend.watchForChanges(() => {
      rescanBackend(backend)
        .then(() => broadcastCurrent())
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("broadcast error", new Error(msg));
        });
    });
    watcherStops.push(watcher);
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          hostname: osHostname(),
          projects: currentFilteredState(),
        }),
      );
    }
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

    if (url.pathname.startsWith("/js/")) {
      const filePath = resolve(publicDir, url.pathname.slice(1));
      if (!filePath.startsWith(`${publicDir}/`)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
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
        log.error("initial scan error", new Error(msg));
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
