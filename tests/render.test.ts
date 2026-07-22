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
const backendManagerSource = readFileSync(
  join(testDir, "../public/js/backend-manager.js"),
  "utf8",
);

type CardHeaderProject = {
  _backendKey?: string;
  _hostname?: string;
  displayName?: string;
  projectName: string;
  source: string;
  sessionId?: string;
  sessionName?: string;
  state?: string;
};

type CardHeaderData = {
  hostname: string;
  projectName: string;
  sessionName: string;
  state: string;
  stateLabel: string;
};

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
  cardHeaderData: (
    project: CardHeaderProject,
    displayName?: string,
  ) => CardHeaderData;
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
    cardHeaderData?: (
      project: CardHeaderProject,
      displayName?: string,
    ) => CardHeaderData;
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
    !context.cardHeaderData ||
    !context.getSortedProjects
  ) {
    throw new Error("render helpers not loaded from browser sources");
  }

  return {
    projKey: context.projKey,
    cardHeaderData: context.cardHeaderData,
    setNow: (now: number) => {
      FakeDate.nowValue = now;
    },
    getSortedProjects: context.getSortedProjects,
  };
}

function loadBackendMergeHelper(): (entry: {
  hostname: string | null;
  projects: Array<Record<string, unknown>>;
  url: string;
}) => Array<Record<string, unknown>> {
  const context = {
    document: { getElementById: () => null },
  } as {
    document: { getElementById: () => null };
    mergeBackendProjects?: (entry: {
      hostname: string | null;
      projects: Array<Record<string, unknown>>;
      url: string;
    }) => Array<Record<string, unknown>>;
  };

  vm.runInNewContext(backendManagerSource, context);

  if (!context.mergeBackendProjects) {
    throw new Error(
      "mergeBackendProjects helper not loaded from backend-manager.js",
    );
  }

  return context.mergeBackendProjects;
}

function loadCreateCard(): (
  project: Record<string, unknown>,
  flashStopped: boolean,
  flashNotification: boolean,
  displayName: string | undefined,
  key: string,
) => { className: string; innerHTML: string } {
  class CardElement {
    className = "";
    innerHTML = "";
    classList = { remove: () => {} };

    addEventListener(): void {}
  }

  const context = {
    Date,
    Map,
    Set,
    document: { createElement: () => new CardElement() },
  } as {
    Date: DateConstructor;
    Map: MapConstructor;
    Set: SetConstructor;
    document: { createElement: () => CardElement };
    createCard?: (
      project: Record<string, unknown>,
      flashStopped: boolean,
      flashNotification: boolean,
      displayName: string | undefined,
      key: string,
    ) => CardElement;
  };

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(renderSource, context);

  if (!context.createCard) {
    throw new Error("createCard helper not loaded from render.js");
  }

  return context.createCard;
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

  test("cardHeaderData keeps explicit cross-server displayName with hostname, state, and a named session", () => {
    const { cardHeaderData } = loadSessionRenderHelpers();

    expect(
      cardHeaderData(
        {
          _backendKey: "fallback-host",
          _hostname: "build-host",
          displayName: "worktrees/ccmon (ses_1234567890abcdef)",
          projectName: "ccmon",
          source: "opencode",
          sessionName: "Pair on flaky test",
          sessionId: "ses_1234567890abcdef",
          state: "waiting_for_permission",
        },
        "build-host:ccmon",
      ),
    ).toEqual({
      hostname: "build-host",
      projectName: "build-host:ccmon",
      sessionName: "Pair on flaky test",
      state: "waiting_for_permission",
      stateLabel: "Waiting",
    });
    expect(
      cardHeaderData(
        {
          projectName: "ccmon",
          source: "opencode",
        },
        "build-host:ccmon",
      ).projectName,
    ).toBe("build-host:ccmon");
  });

  test("cardHeaderData omits a session when only a short opencode id is available", () => {
    const { cardHeaderData } = loadSessionRenderHelpers();

    expect(
      cardHeaderData({
        _hostname: "build-host",
        projectName: "ccmon",
        source: "opencode",
        sessionId: "ses_1234567890abcdef",
        state: "running",
      }).sessionName,
    ).toBe("");
    expect(
      cardHeaderData({
        _hostname: "build-host",
        projectName: "ccmon",
        sessionName: " \t\n ",
        source: "opencode",
        state: "running",
      }).sessionName,
    ).toBe("");
  });

  test("createCard omits the session row when no human-readable name exists", () => {
    const createCard = loadCreateCard();

    const card = createCard(
      {
        _hostname: "build-host",
        projectName: "ccmon",
        sessionName: " \t ",
        sessionId: "ses_1234567890abcdef",
        source: "opencode",
        state: "running",
      },
      false,
      false,
      undefined,
      "build-host::ses_1234567890abcdef",
    );

    expect(card.innerHTML).not.toContain("card-session");
    expect(card.innerHTML).not.toContain("ses_123456");
  });

  test("createCard orders state, project, and host while retaining card content", () => {
    const createCard = loadCreateCard();

    const card = createCard(
      {
        _hostname: "build-host",
        displayName: "worktrees/ccmon",
        inputTokens: 80_000,
        latestAssistantActivity: { text: "Updated the renderer" },
        latestUserActivity: { text: "Redesign the card" },
        model: "claude-sonnet-4",
        projectName: "ccmon",
        sessionName: "Refine dashboard identity",
        source: "opencode",
        state: "running",
        subagents: [
          {
            agentId: "ses_child",
            description: "Review styles",
            isActive: true,
          },
        ],
        tasks: [
          { status: "completed" },
          { status: "in_progress" },
          { status: "deleted" },
        ],
      },
      false,
      false,
      undefined,
      "build-host::ses_main",
    );

    const stateIndex = card.innerHTML.indexOf('class="badge badge-running"');
    const projectIndex = card.innerHTML.indexOf(
      'class="card-project" title="worktrees/ccmon">worktrees/ccmon',
    );
    const hostIndex = card.innerHTML.indexOf(
      'class="card-host" title="build-host">build-host',
    );
    const projectEndIndex = card.innerHTML.indexOf("</span>", projectIndex);
    const betweenProjectAndHost = card.innerHTML.slice(
      projectEndIndex + "</span>".length,
      hostIndex,
    );

    expect(stateIndex).toBeGreaterThan(-1);
    expect(card.innerHTML).not.toContain('class="card-separator"');
    expect(card.innerHTML).not.toContain('class="badge-source"');
    expect(card.innerHTML).not.toContain(">OC<");
    expect(card.innerHTML).not.toContain(">CC<");
    expect(projectIndex).toBeGreaterThan(stateIndex);
    expect(hostIndex).toBeGreaterThan(projectIndex);
    expect(betweenProjectAndHost).not.toMatch(/[-—]/);
    expect(card.innerHTML).toContain("Running");
    expect(card.innerHTML).toContain(
      'class="card-session" title="Refine dashboard identity">Refine dashboard identity',
    );
    expect(card.innerHTML).toContain("📋 1/2");
    expect(card.innerHTML).toContain("Main agent");
    expect(card.innerHTML).toContain("Sub: Review styles");
  });

  test("createCard renders distinct project and hostname values in their own identity slots", () => {
    const createCard = loadCreateCard();

    const card = createCard(
      {
        _hostname: "ci-mac-mini",
        projectName: "dotfiles",
        source: "opencode",
        state: "running",
      },
      false,
      false,
      undefined,
      "ci-mac-mini::ses_dotfiles",
    );

    expect(card.innerHTML).toContain(
      'class="card-project" title="dotfiles">dotfiles',
    );
    expect(card.innerHTML).toContain(
      'class="card-host" title="ci-mac-mini">ci-mac-mini',
    );
    expect(card.innerHTML).not.toContain(
      'class="card-project" title="ci-mac-mini">',
    );
    expect(card.innerHTML).not.toContain('class="card-host" title="dotfiles">');
  });

  test("createCard keeps same-named projects distinguishable across hosts", () => {
    const createCard = loadCreateCard();
    const project = {
      displayName: "ccmon",
      projectName: "ccmon",
      source: "opencode",
      state: "running",
    };

    const hostA = createCard(
      { ...project, _hostname: "host-a" },
      false,
      false,
      "host-a:ccmon",
      "host-a::ses_a",
    );
    const hostB = createCard(
      { ...project, _hostname: "host-b" },
      false,
      false,
      "host-b:ccmon",
      "host-b::ses_b",
    );

    expect(hostA.innerHTML).toContain(
      'class="card-project" title="host-a:ccmon">host-a:ccmon',
    );
    expect(hostB.innerHTML).toContain(
      'class="card-project" title="host-b:ccmon">host-b:ccmon',
    );
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

describe("frontend backend project merge", () => {
  test("propagates the WebSocket hostname to every cloned project", () => {
    const mergeBackendProjects = loadBackendMergeHelper();
    const originals = [
      { projectName: "ccmon", sessionId: "ses_123" },
      {
        _hostname: "stale-host",
        projectName: "ccmon-cli",
        sessionId: "ses_456",
      },
    ];

    expect(
      mergeBackendProjects({
        hostname: "build-host",
        projects: originals,
        url: "ws://build-host/ws",
      }),
    ).toEqual([
      {
        _backendKey: "build-host",
        _hostname: "build-host",
        projectName: "ccmon",
        sessionId: "ses_123",
      },
      {
        _backendKey: "build-host",
        _hostname: "build-host",
        projectName: "ccmon-cli",
        sessionId: "ses_456",
      },
    ]);
    expect(originals[0]).not.toHaveProperty("_hostname");
    expect(originals[1]._hostname).toBe("stale-host");
  });
});
