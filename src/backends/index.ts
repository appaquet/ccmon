import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CcmonConfig } from "../config";
import { log } from "../log";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
} from "../timing.js";
import { ClaudeBackend } from "./claude";
import { OpencodeBackend } from "./opencode";
import type { SessionBackend } from "./types";

function createClaudeBackend(entry: {
  type: "claude";
  enabled: boolean;
  projectsDir?: string;
}): SessionBackend | null {
  const projectsDir =
    entry.projectsDir ??
    process.env.CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects");
  return new ClaudeBackend(projectsDir);
}

function createOpencodeBackend(entry: {
  type: "opencode";
  enabled: boolean;
  databasePath?: string;
  pollIntervalMs?: number;
  statusLogPath?: string;
  statusPollIntervalMs?: number;
}): { backend: SessionBackend; db: DatabaseSync } | null {
  const databasePath =
    entry.databasePath ??
    join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(databasePath)) {
    if (entry.databasePath !== undefined) {
      log.warn("OpenCode database not found, skipping", undefined, {
        path: databasePath,
      });
    }
    return null;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_POLL_INTERVAL_MS}`);
  } catch (err) {
    log.warn("failed to open OpenCode database, skipping", err, {
      path: databasePath,
    });
    return null;
  }
  const statusLogPath =
    entry.statusLogPath ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "ccmon",
      "opencode-status.jsonl",
    );
  const backend = new OpencodeBackend(
    db,
    entry.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    statusLogPath,
    entry.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  return { backend, db };
}

/**
 * Creates SessionBackend instances from the config's backends array.
 * Skips entries with `enabled: false`.
 * Returns backends and a close function that releases all resources (DB handles, etc.).
 * CLI callers must call close() after scanning completes; the server calls close() on shutdown.
 */
export function createBackends(config: CcmonConfig): {
  backends: SessionBackend[];
  close: () => void;
} {
  const backends: SessionBackend[] = [];
  const dbs: DatabaseSync[] = [];

  for (const entry of config.backends) {
    if (!entry.enabled) continue;

    switch (entry.type) {
      case "claude": {
        const backend = createClaudeBackend(entry);
        if (backend) backends.push(backend);
        break;
      }
      case "opencode": {
        const result = createOpencodeBackend(entry);
        if (result) {
          backends.push(result.backend);
          dbs.push(result.db);
        }
        break;
      }
      default: {
        log.warn("unknown backend type, skipping", undefined, {
          type: (entry as { type: string }).type,
        });
      }
    }
  }

  return {
    backends,
    close: () => {
      for (const db of dbs) {
        try {
          db.close();
        } catch {}
      }
    },
  };
}
