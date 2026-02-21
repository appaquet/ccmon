import type { ServerWebSocket } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectState, filterStaleProjects } from './sessions';
import { DEFAULT_CONFIG } from './config';
import { watchForChanges } from './watcher';

const DEFAULT_CLAUDE_DIR = `${Bun.env.HOME ?? '/root'}/.claude/projects`;

export interface ServerOptions {
  port?: number;
  hostname?: string;
  claudeDir?: string;
  maxInactivityHours?: number;
}

/**
 * Starts the HTTP + WebSocket server.
 * Returns the actual port (useful when port 0 is passed for OS assignment) and a stop function.
 */
export function startServer(options: ServerOptions = {}): { port: number; stop: () => void } {
  const port = options.port ?? DEFAULT_CONFIG.port;
  const hostname = options.hostname ?? DEFAULT_CONFIG.host;
  const claudeDir = options.claudeDir ?? DEFAULT_CLAUDE_DIR;
  const maxInactivityHours = options.maxInactivityHours ?? DEFAULT_CONFIG.maxInactivityHours;

  const htmlPath = join(import.meta.dir, '..', 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  const clients = new Set<ServerWebSocket<unknown>>();

  async function broadcastState(changedProjectDir?: string): Promise<void> {
    if (clients.size === 0) return;
    const state = filterStaleProjects(await getProjectState(claudeDir, changedProjectDir), maxInactivityHours);
    const payload = JSON.stringify(state);
    for (const ws of clients) {
      ws.send(payload);
    }
  }

  const watcher = watchForChanges(claudeDir, (projectDir: string) => {
    broadcastState(projectDir).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ccmon: broadcast error: ${msg}\n`);
    });
  });

  const server = Bun.serve({
    port,
    hostname,
    websocket: {
      open(ws) {
        clients.add(ws);
        getProjectState(claudeDir)
          .then((rawState) => {
            const state = filterStaleProjects(rawState, maxInactivityHours);
            ws.send(JSON.stringify(state));
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`ccmon: initial state error: ${msg}\n`);
          });
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
        return getProjectState(claudeDir).then((rawState) =>
          Response.json(filterStaleProjects(rawState, maxInactivityHours)),
        );
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
    stop(): void {
      watcher.stop();
      server.stop(true);
    },
  };
}
