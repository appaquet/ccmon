import { describe, expect, test } from "vitest";
import { log } from "../src/log.ts";

describe("log", () => {
  test("does not mutate caller-owned error fields", () => {
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "silent";
    const fields = { operation: "scan" };

    try {
      log.warn("failed", new Error("problem"), fields);
      log.error("failed", "problem", fields);
      expect(fields).toEqual({ operation: "scan" });
    } finally {
      if (originalLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLevel;
    }
  });
});
