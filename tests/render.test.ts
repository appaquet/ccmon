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
const dashboardSource = readFileSync(
  join(testDir, "../public/index.html"),
  "utf8",
);

type CardHeaderProject = {
  _backendKey?: string;
  _displayHostname?: string;
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
  crossServerDisplayName: (
    project: CardHeaderProject,
    isCrossServerCollision: boolean,
  ) => string | undefined;
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
  dismissalKey: (project: {
    _backendKey: string;
    source: string;
    sessionId?: string;
  }) => string;
  normalizedState: (project: { state?: string }) => string;
  visibleProjects: <
    T extends {
      _backendKey: string;
      source: string;
      sessionId?: string;
      state?: string;
    },
  >(
    projects: T[],
  ) => T[];
  dismissedCards: Map<string, string>;
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
    crossServerDisplayName?: (
      project: CardHeaderProject,
      isCrossServerCollision: boolean,
    ) => string | undefined;
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
    dismissalKey?: (project: {
      _backendKey: string;
      source: string;
      sessionId?: string;
    }) => string;
    normalizedState?: (project: { state?: string }) => string;
    visibleProjects?: <
      T extends {
        _backendKey: string;
        source: string;
        sessionId?: string;
        state?: string;
      },
    >(
      projects: T[],
    ) => T[];
    dismissedCards?: Map<string, string>;
    FakeDate?: typeof FakeDate;
  };
  context.FakeDate = FakeDate;

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(renderSource, context);

  if (
    !context.projKey ||
    !context.cardHeaderData ||
    !context.crossServerDisplayName ||
    !context.getSortedProjects ||
    !context.dismissalKey ||
    !context.normalizedState ||
    !context.visibleProjects ||
    !context.dismissedCards
  ) {
    throw new Error("render helpers not loaded from browser sources");
  }

  return {
    projKey: context.projKey,
    cardHeaderData: context.cardHeaderData,
    crossServerDisplayName: context.crossServerDisplayName,
    setNow: (now: number) => {
      FakeDate.nowValue = now;
    },
    getSortedProjects: context.getSortedProjects,
    dismissalKey: context.dismissalKey,
    normalizedState: context.normalizedState,
    visibleProjects: context.visibleProjects,
    dismissedCards: context.dismissedCards,
  };
}

function loadHostnameDisplayHelpers(): {
  shortHostname: (hostname: string) => string;
  hostnameDisplayMap: (hostnames: string[]) => Map<string, string>;
} {
  const context = { Map, Set } as {
    Map: MapConstructor;
    Set: SetConstructor;
    shortHostname?: (hostname: string) => string;
    hostnameDisplayMap?: (hostnames: string[]) => Map<string, string>;
  };

  vm.runInNewContext(utilsSource, context);

  if (!context.shortHostname || !context.hostnameDisplayMap) {
    throw new Error("hostname display helpers not loaded from utils.js");
  }

  return {
    shortHostname: context.shortHostname,
    hostnameDisplayMap: context.hostnameDisplayMap,
  };
}

function loadBackendDisplayHelpers(): {
  mergeBackendProjects: (
    entry: {
      hostname: string | null;
      projects: Array<Record<string, unknown>>;
      url: string;
    },
    displayHostnames?: Map<string, string>,
  ) => Array<Record<string, unknown>>;
  configuredHostnameDisplayMap: (
    entries: Array<{ hostname: string | null; url: string }>,
  ) => Map<string, string>;
} {
  const context = {
    Map,
    Set,
    document: { getElementById: () => null },
  } as {
    Map: MapConstructor;
    Set: SetConstructor;
    document: { getElementById: () => null };
    mergeBackendProjects?: (
      entry: {
        hostname: string | null;
        projects: Array<Record<string, unknown>>;
        url: string;
      },
      displayHostnames?: Map<string, string>,
    ) => Array<Record<string, unknown>>;
    configuredHostnameDisplayMap?: (
      entries: Array<{ hostname: string | null; url: string }>,
    ) => Map<string, string>;
  };

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(backendManagerSource, context);

  if (!context.mergeBackendProjects || !context.configuredHostnameDisplayMap) {
    throw new Error(
      "backend display helpers not loaded from backend-manager.js",
    );
  }

  return {
    mergeBackendProjects: context.mergeBackendProjects,
    configuredHostnameDisplayMap: context.configuredHostnameDisplayMap,
  };
}

function renderBackendMenuRows(
  entries: Array<{ hostname: string | null; url: string }>,
): string[] {
  const rows: Array<{ innerHTML: string }> = [];
  const backendList = {
    innerHTML: "",
    appendChild: (row: { innerHTML: string }) => rows.push(row),
  };
  const context = {
    Map,
    Set,
    document: {
      createElement: () => ({
        className: "",
        innerHTML: "",
        querySelector: () => ({ addEventListener: () => {} }),
      }),
      getElementById: (id: string) =>
        id === "backend-list" ? backendList : null,
    },
  } as unknown as {
    BackendManager: {
      backends: Array<{ hostname: string | null; url: string }>;
    };
    updateBackendMenu: () => void;
  };

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(backendManagerSource, context);
  context.BackendManager.backends = entries;
  context.updateBackendMenu();
  return rows.map((row) => row.innerHTML);
}

function addBackendAndGetDisplayMap(
  entries: Array<Record<string, unknown>>,
  url: string,
  learnedHostname: string,
): {
  backends: Array<Record<string, unknown>>;
  displayHostnames: Map<string, string>;
  savedUrls: string | undefined;
} {
  let savedUrls: string | undefined;
  const backendList = {
    innerHTML: "",
    appendChild: () => {},
  };
  const context = {
    Map,
    Set,
    document: {
      createElement: () => ({
        className: "",
        innerHTML: "",
        querySelector: () => ({ addEventListener: () => {} }),
      }),
      getElementById: () => backendList,
    },
    localStorage: {
      setItem: (_key: string, value: string) => (savedUrls = value),
    },
  } as unknown as {
    BackendManager: {
      _connect: (entry: Record<string, unknown>) => void;
      addBackend: (url: string) => void;
      backends: Array<Record<string, unknown>>;
    };
    configuredHostnameDisplayMap: (
      entries: Array<{ hostname: string | null; url: string }>,
    ) => Map<string, string>;
  };

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(backendManagerSource, context);
  context.BackendManager.backends = entries;
  context.BackendManager._connect = (entry) => {
    entry.hostname = learnedHostname;
  };
  context.BackendManager.addBackend(url);

  return {
    backends: context.BackendManager.backends,
    displayHostnames: context.configuredHostnameDisplayMap(
      context.BackendManager.backends as Array<{
        hostname: string | null;
        url: string;
      }>,
    ),
    savedUrls,
  };
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
    hideButton = { addEventListener: () => {} };

    addEventListener(): void {}

    querySelector(selector: string): { addEventListener: () => void } | null {
      return selector === ".card-hide" ? this.hideButton : null;
    }
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

function loadDismissalHarness(): {
  createCard: (project: Record<string, unknown>) => {
    innerHTML: string;
    hideButton: {
      clickListener?: (event: { stopPropagation: () => void }) => void;
    };
  };
  dismissalKey: (project: Record<string, unknown>) => string;
  dismissedCards: Map<string, string>;
  flashNotification: Map<string, number>;
  gridChildren: () => Array<{
    className: string;
    innerHTML: string;
    textContent: string;
  }>;
  render: (projects: Array<Record<string, unknown>>) => void;
} {
  class FakeButton {
    clickListener?: (event: { stopPropagation: () => void }) => void;

    addEventListener(
      eventName: string,
      listener: (event: { stopPropagation: () => void }) => void,
    ): void {
      if (eventName === "click") this.clickListener = listener;
    }
  }

  class FakeCard {
    className = "";
    innerHTML = "";
    textContent = "";
    classList = { remove: () => {} };
    hideButton = new FakeButton();

    addEventListener(): void {}

    querySelector(selector: string): FakeButton | null {
      return selector === ".card-hide" ? this.hideButton : null;
    }
  }

  let gridChildren: FakeCard[] = [];
  const grid = {
    get innerHTML(): string {
      return "";
    },
    set innerHTML(_value: string) {
      gridChildren = [];
    },
    appendChild: (child: FakeCard) => gridChildren.push(child),
  };
  const context = {
    Date,
    Map,
    Set,
    document: {
      createElement: () => new FakeCard(),
      getElementById: () => grid,
    },
  } as unknown as {
    createCard?: (project: Record<string, unknown>) => FakeCard;
    dismissalKey?: (project: Record<string, unknown>) => string;
    dismissedCards?: Map<string, string>;
    flashNotification?: Map<string, number>;
    render?: (projects: Array<Record<string, unknown>>) => void;
  };

  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(renderSource, context);

  if (
    !context.createCard ||
    !context.dismissalKey ||
    !context.dismissedCards ||
    !context.flashNotification ||
    !context.render
  ) {
    throw new Error("dismissal harness not loaded from browser sources");
  }

  return {
    createCard: context.createCard,
    dismissalKey: context.dismissalKey,
    dismissedCards: context.dismissedCards,
    flashNotification: context.flashNotification,
    gridChildren: () => gridChildren,
    render: context.render,
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

  test("uses display-only hostnames for card host text and cross-server prefixes", () => {
    const { cardHeaderData, crossServerDisplayName } =
      loadSessionRenderHelpers();
    const project = {
      _backendKey: "build.local",
      _displayHostname: "build",
      _hostname: "build.local",
      projectName: "ccmon",
      source: "opencode",
    };

    expect(cardHeaderData(project).hostname).toBe("build");
    expect(crossServerDisplayName(project, true)).toBe("build:ccmon");
    expect(crossServerDisplayName(project, false)).toBeUndefined();
    expect(project).toEqual({
      _backendKey: "build.local",
      _displayHostname: "build",
      _hostname: "build.local",
      projectName: "ccmon",
      source: "opencode",
    });
  });

  test("uses effective workspace display names for cross-server collision prefixes without changing dismissal identity", () => {
    const { crossServerDisplayName, dismissalKey } = loadSessionRenderHelpers();
    const project = {
      _backendKey: "build.local",
      _displayHostname: "build",
      _hostname: "build.local",
      cwd: "/work/repo/.workspaces/alpha/packages/web",
      displayName: "repo/alpha",
      projectName: "web",
      sessionId: "ses_alpha",
      source: "opencode",
    };

    expect(crossServerDisplayName(project, true)).toBe("build:repo/alpha");
    expect(dismissalKey(project)).toBe(
      JSON.stringify(["build.local", "opencode", "ses_alpha"]),
    );
    expect(project).toEqual({
      _backendKey: "build.local",
      _displayHostname: "build",
      _hostname: "build.local",
      cwd: "/work/repo/.workspaces/alpha/packages/web",
      displayName: "repo/alpha",
      projectName: "web",
      sessionId: "ses_alpha",
      source: "opencode",
    });
  });

  test("groups cross-server workspace collisions by effective displayName", () => {
    const harness = loadDismissalHarness();
    harness.render([
      {
        _backendKey: "host-a",
        _hostname: "host-a",
        displayName: "repo/alpha",
        projectName: "web",
        sessionId: "ses_a",
        source: "opencode",
        state: "running",
      },
      {
        _backendKey: "host-b",
        _hostname: "host-b",
        displayName: "repo/alpha",
        projectName: "api",
        sessionId: "ses_b",
        source: "claude",
        state: "running",
      },
    ]);

    expect(harness.gridChildren().map((card) => card.innerHTML)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("host-a:repo/alpha"),
        expect.stringContaining("host-b:repo/alpha"),
      ]),
    );
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

  test("createCard renders the display hostname in both host text and title", () => {
    const createCard = loadCreateCard();
    const card = createCard(
      {
        _backendKey: "ci.local",
        _displayHostname: "ci",
        _hostname: "ci.local",
        projectName: "dotfiles",
        source: "opencode",
        state: "running",
      },
      false,
      false,
      undefined,
      "ci.local::ses_dotfiles",
    );

    expect(card.innerHTML).toContain('class="card-host" title="ci">ci');
    expect(card.innerHTML).not.toContain("ci.local");
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

describe("transient card dismissal", () => {
  const states = [
    "running",
    "stopped",
    "waiting_for_permission",
    "error",
    "closed",
  ];

  test("hides every supported state only for its exact raw backend, source, and session identity", () => {
    const { dismissalKey, dismissedCards, normalizedState, visibleProjects } =
      loadSessionRenderHelpers();
    const projects = states.map((state, index) => ({
      _backendKey: "host-a",
      projectName: `project-${index}`,
      sessionId: `session-${index}`,
      source: "opencode",
      state,
    }));

    for (const project of projects) {
      dismissedCards.set(dismissalKey(project), normalizedState(project));
    }

    expect(visibleProjects(projects)).toEqual([]);
    expect(dismissalKey(projects[0])).toBe(
      JSON.stringify(["host-a", "opencode", "session-0"]),
    );
  });

  test("does not hide a matching session id from another raw backend or source", () => {
    const { dismissalKey, dismissedCards, normalizedState, visibleProjects } =
      loadSessionRenderHelpers();
    const dismissed = {
      _backendKey: "host-a.local",
      projectName: "ccmon",
      sessionId: "shared-session",
      source: "opencode",
      state: "running",
    };
    const sameSessionDifferentSource = {
      ...dismissed,
      source: "claude",
    };
    const sameSessionDifferentBackend = {
      ...dismissed,
      _backendKey: "host-a",
    };

    dismissedCards.set(dismissalKey(dismissed), normalizedState(dismissed));

    expect(
      visibleProjects([
        dismissed,
        sameSessionDifferentSource,
        sameSessionDifferentBackend,
      ]),
    ).toEqual([sameSessionDifferentSource, sameSessionDifferentBackend]);
  });

  test("retains same-state dismissals and clears them on state changes, session replacement, and absence", () => {
    const { dismissalKey, dismissedCards, normalizedState, visibleProjects } =
      loadSessionRenderHelpers();
    const running = {
      _backendKey: "host-a",
      projectName: "ccmon",
      sessionId: "session-one",
      source: "opencode",
      state: "running",
    };

    dismissedCards.set(dismissalKey(running), normalizedState(running));
    expect(visibleProjects([running])).toEqual([]);

    const stopped = { ...running, state: "stopped" };
    expect(visibleProjects([stopped])).toEqual([stopped]);
    expect(dismissedCards.size).toBe(0);

    dismissedCards.set(dismissalKey(running), normalizedState(running));
    const replacement = { ...running, sessionId: "session-two" };
    expect(visibleProjects([replacement])).toEqual([replacement]);
    expect(dismissedCards.size).toBe(0);

    dismissedCards.set(dismissalKey(running), normalizedState(running));
    expect(visibleProjects([])).toEqual([]);
    expect(dismissedCards.size).toBe(0);
    expect(visibleProjects([running])).toEqual([running]);
  });

  test("starts with no dismissals after a page reload", () => {
    const firstPage = loadSessionRenderHelpers();
    const project = {
      _backendKey: "host-a",
      projectName: "ccmon",
      sessionId: "session-one",
      source: "opencode",
      state: "running",
    };
    firstPage.dismissedCards.set(
      firstPage.dismissalKey(project),
      firstPage.normalizedState(project),
    );

    const reloadedPage = loadSessionRenderHelpers();
    expect(reloadedPage.dismissedCards.size).toBe(0);
    expect(reloadedPage.visibleProjects([project])).toEqual([project]);
  });

  test("uses a semantic button, stops click propagation, and records only an in-memory dismissal", () => {
    const harness = loadDismissalHarness();
    const project = {
      _backendKey: "host-a",
      projectName: "ccmon",
      sessionId: "session-one",
      sessionName: "Inspect render tests",
      source: "opencode",
      state: "running",
    };
    harness.render([project]);
    const card = harness.createCard(project);
    let propagationStopped = false;

    card.hideButton.clickListener?.({
      stopPropagation: () => {
        propagationStopped = true;
      },
    });

    expect(card.innerHTML).toContain(
      'type="button" class="card-hide" aria-label="Hide session Inspect render tests"',
    );
    expect(card.innerHTML).toContain('<span aria-hidden="true">×</span>');
    expect(propagationStopped).toBe(true);
    expect(harness.dismissedCards).toEqual(
      new Map([[harness.dismissalKey(project), "running"]]),
    );
    expect(renderSource).not.toMatch(
      /localStorage|sessionStorage|fetch\(|WebSocket|XMLHttpRequest/,
    );
  });

  test("updates notification bookkeeping for hidden cards before filtering them", () => {
    const harness = loadDismissalHarness();
    const project = {
      _backendKey: "host-a",
      notificationTimestamp: "2026-07-23T12:00:00.000Z",
      projectName: "ccmon",
      sessionId: "session-one",
      source: "opencode",
      state: "running",
    };

    harness.render([project]);
    harness.dismissedCards.set(harness.dismissalKey(project), "running");
    harness.render([
      {
        ...project,
        notificationTimestamp: "2026-07-23T12:00:01.000Z",
      },
    ]);

    expect(harness.flashNotification.has("host-a::session-one")).toBe(true);
  });

  test("renders the established empty state when every incoming card is hidden", () => {
    const harness = loadDismissalHarness();
    const project = {
      _backendKey: "host-a",
      projectName: "ccmon",
      sessionId: "session-one",
      source: "opencode",
      state: "running",
    };

    harness.dismissedCards.set(harness.dismissalKey(project), "running");
    harness.render([project]);

    expect(
      harness.gridChildren().map((child) => ({
        className: child.className,
        textContent: child.textContent,
      })),
    ).toEqual([
      { className: "empty-state", textContent: "No active projects" },
    ]);
  });

  test("retains the baseline sort order for the remaining cards after one dismissal", () => {
    const {
      dismissalKey,
      dismissedCards,
      getSortedProjects,
      normalizedState,
      setNow,
      visibleProjects,
    } = loadSessionRenderHelpers();
    const newest = {
      _backendKey: "host-a",
      lastUpdated: new Date(3_000).toISOString(),
      projectName: "newest",
      sessionId: "session-newest",
      source: "opencode",
      state: "running",
    };
    const dismissed = {
      _backendKey: "host-a",
      lastUpdated: new Date(2_000).toISOString(),
      projectName: "dismissed",
      sessionId: "session-dismissed",
      source: "opencode",
      state: "running",
    };
    const oldest = {
      _backendKey: "host-a",
      lastUpdated: new Date(1_000).toISOString(),
      projectName: "oldest",
      sessionId: "session-oldest",
      source: "opencode",
      state: "running",
    };

    setNow(30_000);
    const baselineOrder = getSortedProjects([
      oldest,
      dismissed,
      newest,
    ]) as (typeof newest)[];
    dismissedCards.set(dismissalKey(dismissed), normalizedState(dismissed));

    expect(baselineOrder.map((project) => project.sessionId)).toEqual([
      "session-newest",
      "session-dismissed",
      "session-oldest",
    ]);
    expect(
      visibleProjects(baselineOrder).map((project) => project.sessionId),
    ).toEqual(["session-newest", "session-oldest"]);
  });

  test("keeps flash bookkeeping for hidden cards through stopped, waiting, and error transitions", () => {
    const harness = loadDismissalHarness();
    const running = {
      _backendKey: "host-a",
      projectName: "ccmon",
      sessionId: "session-one",
      source: "opencode",
      state: "running",
    };

    harness.render([running]);

    const dismissAndRenderSameState = (project: typeof running) => {
      harness.dismissedCards.set(harness.dismissalKey(project), project.state);
      harness.render([project]);
      expect(harness.gridChildren()[0]?.className).toBe("empty-state");
    };

    dismissAndRenderSameState(running);
    const stopped = { ...running, state: "stopped" };
    harness.render([stopped]);
    expect(harness.gridChildren()[0]?.className).toContain(
      "card-flashing-stopped",
    );

    dismissAndRenderSameState(stopped);
    const waiting = { ...running, state: "waiting_for_permission" };
    harness.render([waiting]);
    expect(harness.gridChildren()[0]?.className).toContain(
      "card-flashing-waiting",
    );

    dismissAndRenderSameState(waiting);
    const error = { ...running, state: "error" };
    harness.render([error]);
    expect(harness.gridChildren()[0]?.className).toContain(
      "card-flashing-error",
    );
  });

  test("uses the project name as the Hide button fallback and keeps the compact control out of layout flow", () => {
    const createCard = loadCreateCard();
    const card = createCard(
      {
        _backendKey: "host-a",
        projectName: "ccmon",
        sessionId: "session-one",
        source: "opencode",
        state: "running",
      },
      false,
      false,
      undefined,
      "host-a::session-one",
    );

    expect(card.innerHTML).toContain('aria-label="Hide session ccmon"');
    expect(dashboardSource).toMatch(/\.card\s*\{[\s\S]*position:\s*relative/);
    expect(dashboardSource).toMatch(
      /\.card-hide\s*\{[\s\S]*position:\s*absolute/,
    );
    expect(dashboardSource).toMatch(/\.card-hide\s*\{[\s\S]*width:\s*20px/);
    expect(dashboardSource).toMatch(/\.card-hide\s*\{[\s\S]*height:\s*20px/);
    expect(dashboardSource).toMatch(/\.card-hide\s*\{[\s\S]*top:\s*-10px/);
    expect(dashboardSource).toMatch(/\.card-hide\s*\{[\s\S]*right:\s*8px/);
    expect(dashboardSource).toMatch(
      /opacity:\s*0[\s\S]*pointer-events:\s*none/,
    );
    expect(dashboardSource).toMatch(
      /\.card:hover\s+\.card-hide,[\s\S]*\.card-hide:focus-visible/,
    );
    expect(dashboardSource).toMatch(
      /\.card-hide:focus-visible\s*\{[\s\S]*outline:/,
    );
    expect(dashboardSource).not.toContain("@media (hover: none)");
    expect(dashboardSource).not.toContain("pointer: coarse");
    expect(dashboardSource).not.toContain(
      "grid-template-columns: max-content minmax(0, 3fr) minmax(0, 2fr) 20px",
    );
    expect(dashboardSource).toContain("padding: 14px 16px;");
    expect(dashboardSource).toContain("gap: 14px;");
  });
});

describe("frontend backend project merge", () => {
  test("propagates the WebSocket hostname to every cloned project", () => {
    const { mergeBackendProjects } = loadBackendDisplayHelpers();
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
        _displayHostname: "build-host",
        _hostname: "build-host",
        projectName: "ccmon",
        sessionId: "ses_123",
      },
      {
        _backendKey: "build-host",
        _displayHostname: "build-host",
        _hostname: "build-host",
        projectName: "ccmon-cli",
        sessionId: "ses_456",
      },
    ]);
    expect(originals[0]).not.toHaveProperty("_hostname");
    expect(originals[1]._hostname).toBe("stale-host");
  });

  test("derives collision-safe display labels from configured backend hostnames", () => {
    const { mergeBackendProjects, configuredHostnameDisplayMap } =
      loadBackendDisplayHelpers();
    const localEntry = {
      hostname: "build.local",
      projects: [{ projectName: "ccmon", sessionId: "ses_local" }],
      url: "ws://build.local/ws",
    };
    const bareEntry = {
      hostname: "build",
      projects: [{ projectName: "ccmon", sessionId: "ses_bare" }],
      url: "ws://build/ws",
    };
    const uniqueEntry = {
      hostname: "ci.local.",
      projects: [{ projectName: "ccmon", sessionId: "ses_ci" }],
      url: "ws://ci.local/ws",
    };
    const entries = [localEntry, bareEntry, uniqueEntry];
    const displayHostnames = configuredHostnameDisplayMap(entries);

    expect(displayHostnames).toEqual(
      new Map([
        ["build.local", "build.local"],
        ["build", "build"],
        ["ci.local.", "ci"],
      ]),
    );
    expect(mergeBackendProjects(localEntry, displayHostnames)).toEqual([
      {
        _backendKey: "build.local",
        _displayHostname: "build.local",
        _hostname: "build.local",
        projectName: "ccmon",
        sessionId: "ses_local",
      },
    ]);
    expect(mergeBackendProjects(uniqueEntry, displayHostnames)).toEqual([
      {
        _backendKey: "ci.local.",
        _displayHostname: "ci",
        _hostname: "ci.local.",
        projectName: "ccmon",
        sessionId: "ses_ci",
      },
    ]);
    expect(localEntry.projects).toEqual([
      { projectName: "ccmon", sessionId: "ses_local" },
    ]);
  });

  test("uses collision-safe display labels in the backend menu", () => {
    const rows = renderBackendMenuRows([
      { hostname: "build.local", url: "ws://build.local/ws" },
      { hostname: "build", url: "ws://build/ws" },
      { hostname: "ci.local.", url: "ws://ci.local/ws" },
    ]);

    expect(rows[0]).toContain(
      'class="backend-host" title="build.local">build.local',
    );
    expect(rows[1]).toContain('class="backend-host" title="build">build');
    expect(rows[2]).toContain('class="backend-host" title="ci">ci');
  });

  test("recomputes only display labels as backends disconnect, reconnect, and are removed", () => {
    const { configuredHostnameDisplayMap } = loadBackendDisplayHelpers();
    const localEntry = {
      hostname: "build.local",
      projects: [],
      status: "connected",
      url: "ws://build.local/ws",
    };
    const bareEntry = {
      hostname: "build",
      projects: [],
      status: "connected",
      url: "ws://build/ws",
    };

    expect(
      configuredHostnameDisplayMap([localEntry, bareEntry]).get("build.local"),
    ).toBe("build.local");
    bareEntry.status = "disconnected";
    expect(
      configuredHostnameDisplayMap([localEntry, bareEntry]).get("build.local"),
    ).toBe("build.local");
    bareEntry.status = "connected";
    expect(
      configuredHostnameDisplayMap([localEntry, bareEntry]).get("build.local"),
    ).toBe("build.local");
    expect(configuredHostnameDisplayMap([localEntry]).get("build.local")).toBe(
      "build",
    );
    const discoveringEntry = {
      hostname: null as string | null,
      projects: [],
      status: "connecting",
      url: "ws://ci.local/ws",
    };
    expect(
      configuredHostnameDisplayMap([discoveringEntry]).get(
        discoveringEntry.url,
      ),
    ).toBe(discoveringEntry.url);
    discoveringEntry.hostname = "ci.local";
    expect(
      configuredHostnameDisplayMap([discoveringEntry]).get("ci.local"),
    ).toBe("ci");
    expect(localEntry).toEqual({
      hostname: "build.local",
      projects: [],
      status: "connected",
      url: "ws://build.local/ws",
    });
  });

  test("recomputes collisions when addBackend learns a new raw hostname", () => {
    const existing = {
      hostname: "build.local",
      projects: [],
      status: "connected",
      url: "ws://build.local/ws",
    };
    const result = addBackendAndGetDisplayMap(
      [existing],
      "ws://build/ws",
      "build",
    );

    expect(result.displayHostnames).toEqual(
      new Map([
        ["build.local", "build.local"],
        ["build", "build"],
      ]),
    );
    expect(existing).toEqual({
      hostname: "build.local",
      projects: [],
      status: "connected",
      url: "ws://build.local/ws",
    });
    expect(result.backends[1]).toMatchObject({
      hostname: "build",
      status: "connecting",
      url: "ws://build/ws",
    });
    expect(result.savedUrls).toBe(JSON.stringify(["ws://build/ws"]));
  });
});

describe("frontend hostname display", () => {
  test("removes one terminal case-insensitive .local label and one optional DNS dot", () => {
    const { shortHostname } = loadHostnameDisplayHelpers();

    expect(shortHostname("build.local")).toBe("build");
    expect(shortHostname("build.LOCAL")).toBe("build");
    expect(shortHostname("build.local.")).toBe("build");
    expect(shortHostname("build.LOCAL.")).toBe("build");
    expect(shortHostname("build.local.local")).toBe("build.local");
  });

  test("preserves a terminal .local hostname with a label longer than 63 characters", () => {
    const { shortHostname } = loadHostnameDisplayHelpers();
    const hostname = `${"a".repeat(64)}.local`;

    expect(shortHostname(hostname)).toBe(hostname);
  });

  test("preserves bare, nonterminal, malformed, whitespace-bearing, and other-domain hostnames", () => {
    const { shortHostname } = loadHostnameDisplayHelpers();
    const unchanged = [
      "local",
      "localhost",
      "build.local.example",
      "build.example",
      " build.local",
      "build.local ",
      "build..local",
      "build.local..",
      "build-.local",
      "build_local.local",
      ".local",
    ];

    for (const hostname of unchanged) {
      expect(shortHostname(hostname)).toBe(hostname);
    }
  });

  test("retains raw labels for distinct hosts that shorten to the same display label", () => {
    const { hostnameDisplayMap } = loadHostnameDisplayHelpers();

    expect(
      hostnameDisplayMap(["build.local", "build", "ci.LOCAL", "ci.local."]),
    ).toEqual(
      new Map([
        ["build.local", "build.local"],
        ["build", "build"],
        ["ci.LOCAL", "ci.LOCAL"],
        ["ci.local.", "ci.local."],
      ]),
    );
  });
});
