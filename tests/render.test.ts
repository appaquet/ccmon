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
const utilsSource = readFileSync(
  join(testDir, "../public/js/utils.js"),
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

function loadSessionRenderHelpers(): {
  projKey: (project: {
    _backendKey: string;
    source: string;
    cwd?: string;
    projectDir?: string;
    projectName: string;
    sessionId: string;
  }) => string;
  sessionIdentityLabel: (project: {
    source: string;
    sessionId?: string;
    sessionName?: string;
  }) => string;
  setNow: (now: number) => void;
  getSortedProjects: (
    projects: Array<{
      _backendKey: string;
      source: string;
      cwd?: string;
      projectDir?: string;
      projectName: string;
      sessionId: string;
      lastUpdated?: string | null;
    }>,
  ) => Array<{
    sessionId: string;
  }>;
} {
  class FakeDate extends Date {
    static nowValue = 0;

    static now(): number {
      return FakeDate.nowValue;
    }
  }

  const context = { Date: FakeDate, Map, Set } as unknown as {
    Date: DateConstructor;
    Map: MapConstructor;
    Set: SetConstructor;
    projKey?: (project: {
      _backendKey: string;
      source: string;
      cwd?: string;
      projectDir?: string;
      projectName: string;
      sessionId: string;
    }) => string;
    sessionIdentityLabel?: (project: {
      source: string;
      sessionId?: string;
      sessionName?: string;
    }) => string;
    getSortedProjects?: (
      projects: Array<{
        _backendKey: string;
        source: string;
        cwd?: string;
        projectDir?: string;
        projectName: string;
        sessionId: string;
        lastUpdated?: string | null;
      }>,
    ) => Array<{
      sessionId: string;
    }>;
    FakeDate?: typeof FakeDate;
  };
  context.FakeDate = FakeDate;

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(renderSource, context);

  if (
    !context.projKey ||
    !context.sessionIdentityLabel ||
    !context.getSortedProjects
  ) {
    throw new Error("render helpers not loaded from browser sources");
  }

  return {
    projKey: context.projKey,
    sessionIdentityLabel: context.sessionIdentityLabel,
    setNow: (now: number) => {
      FakeDate.nowValue = now;
    },
    getSortedProjects: context.getSortedProjects,
  };
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

describe("render same-repo sibling identity", () => {
  test("projKey is session-scoped for opencode siblings sharing a cwd", () => {
    const { projKey } = loadSessionRenderHelpers();

    const first = projKey({
      _backendKey: "host-a",
      source: "opencode",
      cwd: "/repo",
      projectName: "repo",
      sessionId: "ses_alpha",
    });
    const second = projKey({
      _backendKey: "host-a",
      source: "opencode",
      cwd: "/repo",
      projectName: "repo",
      sessionId: "ses_beta",
    });

    expect(first).not.toBe(second);
  });

  test("sessionIdentityLabel prefers sessionName and falls back to short opencode session id", () => {
    const { sessionIdentityLabel } = loadSessionRenderHelpers();

    expect(
      sessionIdentityLabel({
        source: "opencode",
        sessionName: "Pair on flaky test",
        sessionId: "ses_1234567890abcdef",
      }),
    ).toBe("Pair on flaky test");
    expect(
      sessionIdentityLabel({
        source: "opencode",
        sessionId: "ses_1234567890abcdef",
      }),
    ).toBe("ses_123456");
  });

  test("getSortedProjects keeps older newly-seen siblings behind newer existing sessions", () => {
    const { getSortedProjects, setNow } = loadSessionRenderHelpers();

    const newer = {
      _backendKey: "host-a",
      source: "opencode",
      cwd: "/repo",
      projectName: "repo",
      sessionId: "ses_newer",
      lastUpdated: new Date(2_000).toISOString(),
    };
    const older = {
      _backendKey: "host-a",
      source: "opencode",
      cwd: "/repo",
      projectName: "repo",
      sessionId: "ses_older",
      lastUpdated: new Date(1_000).toISOString(),
    };

    setNow(0);
    getSortedProjects([newer]);
    setNow(5_000);
    const sorted = getSortedProjects([newer, older]);

    expect(sorted.map((project) => project.sessionId)).toEqual([
      "ses_newer",
      "ses_older",
    ]);
  });
});
