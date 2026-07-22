import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { createBackends } from "../../src/backends/index.ts";
import type { CcmonConfig } from "../../src/config.ts";

describe("createBackends OpenCode validation", () => {
  test("closes and skips an invalid OpenCode database while retaining Claude", () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "ccmon-invalid-opencode-")),
      "opencode.db",
    );
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE session (id TEXT, parent_id TEXT)");
    db.close();
    const config: CcmonConfig = {
      maxInactivityHours: 1,
      host: "127.0.0.1",
      port: 0,
      backends: [
        { type: "claude", enabled: true },
        { type: "opencode", enabled: true, databasePath },
      ],
    };

    const { backends, close } = createBackends(config);

    expect(backends.map((backend) => backend.source)).toEqual(["claude"]);
    close();
  });
});
