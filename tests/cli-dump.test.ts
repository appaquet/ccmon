import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";

const close = vi.fn();
const createBackends = vi.fn(() => ({ backends: [], close }));
const collectBackendStates = vi.fn();

vi.mock("../src/backends/index.ts", () => ({ createBackends }));
vi.mock("../src/backends/collect-states.ts", () => ({ collectBackendStates }));

const { runDump } = await import("../src/cli/commands/dump.ts");

describe("runDump", () => {
  afterEach(() => {
    close.mockReset();
    createBackends.mockClear();
    collectBackendStates.mockReset();
  });

  test("closes backend resources after a successful collection", async () => {
    collectBackendStates.mockResolvedValue(new Map());
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(runDump(DEFAULT_CONFIG, null)).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
    }
  });

  test("closes backend resources when collection fails", async () => {
    collectBackendStates.mockRejectedValue(new Error("database unavailable"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      await expect(runDump(DEFAULT_CONFIG, null)).resolves.toBe(1);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });
});
