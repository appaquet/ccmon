import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const renderSource = readFileSync(
  join(testDir, "../public/js/render.js"),
  "utf8",
);

function loadSubagentLabel(): (agent: {
  description?: string;
  sessionName?: string;
  slug?: string;
  agentId: string;
}) => string {
  const context = { Date, Map, Set } as {
    Date: DateConstructor;
    Map: MapConstructor;
    Set: SetConstructor;
    subagentLabel?: (agent: {
      description?: string;
      sessionName?: string;
      slug?: string;
      agentId: string;
    }) => string;
  };

  vm.runInNewContext(renderSource, context);

  if (!context.subagentLabel) {
    throw new Error("subagentLabel helper not loaded from render.js");
  }

  return context.subagentLabel;
}

describe("render subagent labels", () => {
  test("prefers description before sessionName, slug, and agentId", () => {
    const label = loadSubagentLabel();

    expect(
      label({
        description: "Claude reviewer",
        sessionName: "OpenCode child title",
        slug: "reviewer",
        agentId: "ses_123",
      }),
    ).toBe("Sub: Claude reviewer");
  });

  test("falls back from sessionName to slug to agentId", () => {
    const label = loadSubagentLabel();

    expect(
      label({
        sessionName: "Investigate subagent naming (@senior-dev subagent)",
        slug: "reviewer",
        agentId: "ses_123",
      }),
    ).toBe("Sub: Investigate subagent naming (@senior-dev subagent)");
    expect(
      label({
        slug: "reviewer",
        agentId: "ses_123",
      }),
    ).toBe("Sub: reviewer");
    expect(
      label({
        agentId: "ses_123",
      }),
    ).toBe("Sub: ses_123");
  });
});
