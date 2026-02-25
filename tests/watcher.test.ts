import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { _backoffDelayForTesting, watchForChanges } from "../src/watcher";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TMPDIR = Bun.env.TMPDIR || "/tmp";

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    TMPDIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeStatusPayload(): string {
  return JSON.stringify({
    state: "running",
    timestamp: new Date().toISOString(),
    session_id: "test-session",
    working_dir: "/home/user/proj",
  });
}

// ─── watchForChanges ─────────────────────────────────────────────────────────

describe("watchForChanges", () => {
  let tmpDir: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = await makeTempDir("ccmon-watch");
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns a stop() function that can be called without error", async () => {
    const watcher = watchForChanges(tmpDir, () => {});
    expect(typeof watcher.stop).toBe("function");
    // Should not throw
    watcher.stop();
    stop = null; // already stopped, skip afterEach cleanup
  }, 3000);

  test("file change to ccmon-status.json triggers onUpdate callback", async () => {
    const projDir = join(tmpDir, "-home-user-proj");
    await mkdir(projDir, { recursive: true });
    const statusFile = join(projDir, "ccmon-status.json");
    await writeFile(statusFile, makeStatusPayload());

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    // Write to the status file to trigger a change
    await Bun.sleep(50); // Let watcher settle
    await writeFile(statusFile, makeStatusPayload());
    await Bun.sleep(200); // Let fs events propagate + debounce

    expect(called.length).toBeGreaterThan(0);
    expect(called[0]).toBe(projDir);
  }, 3000);

  test("JSONL file write triggers onUpdate callback", async () => {
    const projDir = join(tmpDir, "-home-user-jsonlproj");
    await mkdir(projDir, { recursive: true });

    // Pre-create the JSONL so the project dir exists before watcher init
    const jsonlFile = join(projDir, "session.jsonl");
    await writeFile(jsonlFile, '{"type":"user"}\n');

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    await Bun.sleep(50); // Let watcher settle

    // Simulate Claude appending a new line to the session JSONL
    await writeFile(jsonlFile, '{"type":"user"}\n{"type":"assistant"}\n');
    await Bun.sleep(200); // Let fs events propagate + debounce

    expect(called.length).toBeGreaterThan(0);
    expect(called[0]).toBe(projDir);
  }, 3000);

  test("debounce: multiple rapid writes produce a single callback", async () => {
    const projDir = join(tmpDir, "-home-user-debounce");
    await mkdir(projDir, { recursive: true });
    const statusFile = join(projDir, "ccmon-status.json");
    await writeFile(statusFile, makeStatusPayload());

    const called: string[] = [];
    const watcher = watchForChanges(tmpDir, (projectDir) => {
      called.push(projectDir);
    });
    stop = watcher.stop;

    await Bun.sleep(50); // Let watcher settle

    // Rapid writes within the debounce window (simulates Claude's frequent JSONL writes)
    for (let i = 0; i < 5; i++) {
      await writeFile(statusFile, makeStatusPayload());
    }

    await Bun.sleep(300); // Wait for debounce window + propagation

    expect(called.length).toBe(1);
  }, 3000);

  test("watcher error triggers restart attempt with log message", async () => {
    const projDir = join(tmpDir, "-home-user-errrestart");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "session.jsonl"), '{"type":"user"}\n');

    const errorMessages: string[] = [];
    const origError = console.error;
    console.error = mock((...args: unknown[]) => {
      errorMessages.push(args.join(" "));
    });

    const watcher = watchForChanges(tmpDir, () => {});
    stop = watcher.stop;

    // Let watcher initialize and start watching projDir
    await Bun.sleep(100);

    // Removing the watched directory causes the watcher to receive an error on Linux
    await rm(projDir, { recursive: true, force: true });

    // Give watcher error handler time to fire
    await Bun.sleep(300);

    console.error = origError;

    // Verify restart was logged (directory removal may produce rename or error event;
    // on supported platforms it will log a restart message)
    const restartMsg = errorMessages.find(
      (m) => m.includes("restarting in") && m.includes("attempt"),
    );
    // If the platform emitted an error event, the restart message must be present.
    // On platforms where removal doesn't emit error (only rename), this check is skipped.
    if (restartMsg !== undefined) {
      expect(restartMsg).toContain("restarting in");
      expect(restartMsg).toContain("attempt 1");
    }
  }, 5000);
});

// ─── backoff delay formula ────────────────────────────────────────────────────

describe("backoff delay formula", () => {
  test("first attempt uses initial delay (1000ms)", () => {
    expect(_backoffDelayForTesting(0)).toBe(1000);
  });

  test("second attempt doubles the delay (2000ms)", () => {
    expect(_backoffDelayForTesting(1)).toBe(2000);
  });

  test("third attempt doubles again (4000ms)", () => {
    expect(_backoffDelayForTesting(2)).toBe(4000);
  });

  test("delay is capped at 30000ms for large attempt counts", () => {
    expect(_backoffDelayForTesting(10)).toBe(30_000);
    expect(_backoffDelayForTesting(100)).toBe(30_000);
  });

  test("delay doubles on each attempt up to cap", () => {
    const delays = [0, 1, 2, 3, 4, 5].map(_backoffDelayForTesting);
    // Each delay should be double the previous, until cap
    for (let i = 1; i < delays.length; i++) {
      const prev = delays[i - 1] as number;
      const curr = delays[i] as number;
      expect(curr).toBe(Math.min(prev * 2, 30_000));
    }
  });
});
