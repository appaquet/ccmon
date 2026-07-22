import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CcmonConfig } from "../config.ts";
import { log } from "../log.ts";
import { DEFAULT_CLAUDE_DIR } from "../project-utils.ts";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
} from "../timing.ts";
import { ClaudeBackend } from "./claude.ts";
import { OpencodeBackend } from "./opencode.ts";
import type { AnySessionBackend, BackendConfigEntry } from "./types.ts";

function createClaudeBackend(
  entry: Extract<BackendConfigEntry, { type: "claude" }>,
): AnySessionBackend {
  const projectsDir =
    entry.projectsDir ?? process.env.CLAUDE_PROJECTS_DIR ?? DEFAULT_CLAUDE_DIR;
  return new ClaudeBackend(projectsDir);
}

function createOpencodeBackend(
  entry: Extract<BackendConfigEntry, { type: "opencode" }>,
): { backend: AnySessionBackend; db: DatabaseSync } | null {
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
  try {
    const backend = new OpencodeBackend(
      db,
      entry.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      statusLogPath,
      entry.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS,
    );
    return { backend, db };
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close failures while skipping an invalid backend
    }
    log.warn("invalid OpenCode database, skipping", err, {
      path: databasePath,
    });
    return null;
  }
}

/**
 * Creates SessionBackend instances from the config's backends array.
 * Skips entries with `enabled: false`.
 * Returns backends and a close function that releases all resources (DB handles, etc.).
 * CLI callers must call close() after scanning completes; the server calls close() on shutdown.
 */
export function createBackends(config: CcmonConfig): {
  backends: AnySessionBackend[];
  close: () => void;
} {
  const backends: AnySessionBackend[] = [];
  const dbs: DatabaseSync[] = [];

  for (const entry of config.backends) {
    if (!entry.enabled) continue;

    switch (entry.type) {
      case "claude": {
        backends.push(createClaudeBackend(entry));
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
        } catch {
          // already closed or never opened — ignore
        }
      }
    },
  };
}
