import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CcmonConfig } from "../config";
import { ClaudeBackend } from "./claude";
import { OpencodeBackend } from "./opencode";
import type { SessionBackend } from "./types";

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
        const projectsDir =
          entry.projectsDir ??
          process.env.CLAUDE_PROJECTS_DIR ??
          join(homedir(), ".claude", "projects");
        backends.push(new ClaudeBackend(projectsDir));
        break;
      }
      case "opencode": {
        const databasePath =
          entry.databasePath ??
          join(homedir(), ".local", "share", "opencode", "opencode.db");
        if (!existsSync(databasePath)) {
          if (entry.databasePath !== undefined) {
            console.warn(
              `OpenCode backend: database not found at ${databasePath}, skipping.`,
            );
          }
          continue;
        }
        let db: DatabaseSync;
        try {
          db = new DatabaseSync(databasePath, { readOnly: true });
          db.exec("PRAGMA busy_timeout = 5000");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `OpenCode backend: failed to open database at ${databasePath}: ${message}, skipping.`,
          );
          continue;
        }
        const statusLogPath =
          entry.statusLogPath ??
          join(
            process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
            "ccmon",
            "opencode-status.jsonl",
          );
        backends.push(
          new OpencodeBackend(
            db,
            entry.pollIntervalMs ?? 5000,
            statusLogPath,
            entry.statusPollIntervalMs ?? 30000,
          ),
        );
        dbs.push(db);
        break;
      }
      default: {
        console.warn(
          `Unknown backend type: "${(entry as { type: string }).type}", skipping.`,
        );
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
