import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";

const close = vi.fn();
const stop = vi.fn();
const createBackends = vi.fn(() => ({ backends: [], close }));
const startServer = vi.fn(() => ({
  port: 8080,
  ready: Promise.resolve(),
  stop,
}));

vi.mock("../src/backends/index.ts", () => ({ createBackends }));
vi.mock("../src/server.ts", () => ({ startServer }));

const { runServe } = await import("../src/cli/commands/serve.ts");

describe("runServe", () => {
  const originalSigintListeners = process.listeners("SIGINT");
  const originalSigtermListeners = process.listeners("SIGTERM");

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const listener of originalSigintListeners)
      process.on("SIGINT", listener);
    for (const listener of originalSigtermListeners)
      process.on("SIGTERM", listener);
    close.mockReset();
    stop.mockReset();
    createBackends.mockClear();
    startServer.mockClear();
  });

  test("closes backend resources exactly once during shutdown", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    try {
      await runServe(DEFAULT_CONFIG, undefined, null);
      process.emit("SIGINT");
      process.emit("SIGTERM");

      expect(stop).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
      exit.mockRestore();
    }
  });

  test("forwards broadcastIntervalMs into startServer options", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await runServe(DEFAULT_CONFIG, undefined, null);
      expect(startServer).toHaveBeenCalledWith(
        expect.objectContaining({
          broadcastIntervalMs: DEFAULT_CONFIG.broadcastIntervalMs,
        }),
      );
    } finally {
      stdout.mockRestore();
    }
  });
});
