import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { hostname as osHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { collectBackendStates } from "./backends/collect-states.ts";
import type { AnySessionBackend } from "./backends/types.ts";
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
const staticAssets = loadStaticAssets();

export interface ServerOptions {
  port?: number;
  hostname?: string;
  backends: AnySessionBackend[];
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

  const backendStates = new Map<AnySessionBackend, Map<string, ProjectState>>();

  function allStates(): ProjectState[] {
    const states: ProjectState[] = [];
    for (const subMap of backendStates.values()) {
      for (const state of subMap.values()) states.push(state);
    }
    return states;
  }

  function currentFilteredState(): ProjectState[] {
    const filtered = filterStaleProjects(allStates(), maxInactivityHours);
    return disambiguateProjectNames(sortProjectsByRecency(filtered));
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

  async function buildStateForBackend(
    backend: AnySessionBackend,
  ): Promise<void> {
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
  }

  async function rescanBackend(backend: AnySessionBackend): Promise<void> {
    try {
      await buildStateForBackend(backend);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("rescan error for backend", new Error(msg));
    }
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
    const pathname = requestPath(req);
    if (pathname === null) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFilteredState()));
      return;
    }

    if (pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    if (pathname.startsWith("/js/")) {
      const content = staticAssets.get(pathname);
      if (content !== undefined) {
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        });
        res.end(content);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (requestPath(req) === "/ws" && hasAllowedWebSocketOrigin(req)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  let resolvedPort = port;
  let stopped = false;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(broadcastInterval);
    for (const watcher of watcherStops) watcher.stop();
    wss.close();
    server.close(() => {});
  }

  let resolveReady: () => void;
  let rejectReady: (reason: Error) => void;
  const ready = new Promise<void>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });

  server.once("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      resolvedPort = addr.port;
    }
    resolveReady();
  });

  server.once("error", (error) => {
    stop();
    rejectReady(error);
  });

  server.listen(port, hostname);

  const initialized = ready.then(() =>
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
    ready: initialized,
    stop,
  };
}

function requestPath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://ccmon.invalid").pathname;
  } catch {
    return null;
  }
}

function hasAllowedWebSocketOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || typeof req.headers.host !== "string")
    return false;

  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(`http://${req.headers.host}`);
    return (
      origin === originUrl.origin && originUrl.origin === requestOrigin.origin
    );
  } catch {
    return false;
  }
}

function loadStaticAssets(): Map<string, string> {
  const assets = new Map<string, string>();
  cacheStaticAssets(join(publicDir, "js"), assets);
  return assets;
}

function cacheStaticAssets(
  directory: string,
  assets: Map<string, string>,
): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      cacheStaticAssets(filePath, assets);
    } else if (entry.isFile()) {
      try {
        assets.set(
          filePath.slice(publicDir.length),
          readFileSync(filePath, "utf8"),
        );
      } catch {
        // Missing or unreadable assets retain the existing 404 behavior.
      }
    }
  }
}
