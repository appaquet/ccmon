import type { FSWatcher } from "node:fs";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "../log.ts";
import { parseMessageData, parsePartData } from "../parsers/opencode-db.ts";
import {
  isPluginHeartbeat,
  isStatusEvent,
  parseStatusLogRecords,
  type SessionState,
  type StatusEvent,
} from "../session-core.ts";
import {
  DEBOUNCE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  MAX_FIRST_READ,
  OPENCODE_ACTIVE_THRESHOLD_MS,
  PERMISSION_STALE_MS,
  PLUGIN_HEALTH_THRESHOLD_MS,
  SUBAGENT_EXPIRY_MS,
  SUBAGENT_LIFECYCLE_TIMEOUT_MS,
} from "../timing.ts";
import type {
  NotificationMeta,
  ProjectInfo,
  SessionEnrichment,
  SubagentInfo,
} from "../types.ts";
import type { SessionBackend } from "./types.ts";

type OpencodeProjectInfo = Extract<ProjectInfo, { source: "opencode" }>;

type ChildLifecycleEvidence = {
  event: StatusEvent;
  timestampMs: number;
  isTerminal: boolean;
};

type ChildLifecycleDecision = "live" | "terminal_retained" | "excluded";

type ChildLifecycleRow = {
  time_created: number;
  time_updated: number;
};

type ForestSession = ChildLifecycleRow & {
  id: string;
  parent_id: string | null;
  time_archived: number | null;
  title: string | null;
  directory: string;
  projectName: string | null;
  latestUserMessageMs: number | null;
  latestSqliteActivityMs: number | null;
  latestActiveToolMs: number | null;
};

type ForestSnapshot = {
  rootsById: Map<string, ForestSession>;
  descendantsByRoot: Map<string, ForestSession[]>;
  directChildrenByRoot: Map<string, ForestSession[]>;
};

type BlockerKind = "question" | "permission";

type Blocker = {
  sessionId: string;
  kind: BlockerKind;
  requestId: string | null;
  timestampMs: number;
};

type StatusEventIndex = {
  eventsBySession: Map<string, StatusEvent[]>;
};

type LifecycleMode = "active" | "idle" | "hard_terminal";

type SessionEvidence = {
  mode: LifecycleMode;
  state: SessionState | null;
  blockers: Blocker[];
  latestActivityMs: number | null;
  lifecycle: ChildLifecycleEvidence | null;
  terminalTimestampMs: number | null;
  recoveredGenerationStartMs: number | null;
};

type GenerationEvidence =
  | {
      type: "persisted_user_message";
      timestampMs: number;
    }
  | {
      type: "status";
      event: StatusEvent;
      timestampMs: number;
      order: number;
    };

type RootAggregate = {
  state: SessionState;
  lastUpdatedMs: number;
};

type CollectionSnapshot = {
  now: number;
  forest: ForestSnapshot;
  statusEventIndex: StatusEventIndex;
  evidenceBySession: Map<string, SessionEvidence>;
  aggregatesByRoot: Map<string, RootAggregate>;
};

const LEGACY_REQUEST_SLOT = "__ccmon_legacy_request__";

function statSyncTerse(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** File identity + change basis used by the change-aware status poll. */
interface FileBasis {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

/** Statically captured file basis; `null` when the file cannot be stat'ed. */
function statFileBasis(path: string): FileBasis | null {
  try {
    const s = statSync(path);
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function fileBasisChanged(a: FileBasis, b: FileBasis): boolean {
  return (
    a.dev !== b.dev ||
    a.ino !== b.ino ||
    a.mtimeMs !== b.mtimeMs ||
    a.size !== b.size
  );
}

function resolveDefaultStatusLogPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "ccmon", "opencode-status.jsonl");
}

export class OpencodeBackend implements SessionBackend<OpencodeProjectInfo> {
  readonly source = "opencode" as const;
  private lastStatusLogDev: number | null = null;
  private lastStatusLogIno: number | null = null;
  private lastStatusLogMtime: number | null = null;
  private lastStatusLogSize: number | null = null;
  private statusLogEvents: StatusEvent[] | null = null;
  private statusEventIndex: StatusEventIndex | null = null;
  private lastPluginHeartbeatMs: number | null = null;
  private messageTableAvailable: boolean | null = null;
  private messageTableSchemaVersion: number | null = null;
  private partTableAvailable: boolean | null = null;
  private partTableSchemaVersion: number | null = null;
  private collectionByProject = new WeakMap<
    OpencodeProjectInfo,
    CollectionSnapshot
  >();
  private db: DatabaseSync;
  private pollIntervalMs: number;
  private statusLogPath: string;
  private statusPollIntervalMs: number;

  constructor(
    db: DatabaseSync,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    statusLogPath = resolveDefaultStatusLogPath(),
    statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
  ) {
    this.db = db;
    this.assertParentIdIndex();
    this.pollIntervalMs = pollIntervalMs;
    this.statusLogPath = statusLogPath;
    this.statusPollIntervalMs = statusPollIntervalMs;
  }

  async scanProjects(): Promise<OpencodeProjectInfo[]> {
    const snapshot = this.createCollectionSnapshot();
    return [...snapshot.forest.rootsById.values()]
      .sort(
        (a, b) =>
          b.time_updated - a.time_updated ||
          b.time_created - a.time_created ||
          b.id.localeCompare(a.id),
      )
      .map((root) => {
        const project: OpencodeProjectInfo = {
          cwd: root.directory,
          projectName: root.projectName ?? basename(root.directory),
          sessionId: root.id,
          source: "opencode",
        };
        this.collectionByProject.set(project, snapshot);
        return project;
      });
  }

  async computeLastUpdated(
    projectInfo: OpencodeProjectInfo,
  ): Promise<string | null> {
    const aggregate = this.getCollectionSnapshot(
      projectInfo,
    ).aggregatesByRoot.get(projectInfo.sessionId);
    return aggregate ? new Date(aggregate.lastUpdatedMs).toISOString() : null;
  }

  async resolveState(projectInfo: OpencodeProjectInfo): Promise<SessionState> {
    return (
      this.getCollectionSnapshot(projectInfo).aggregatesByRoot.get(
        projectInfo.sessionId,
      )?.state ?? "stopped"
    );
  }

  async enrichProject(
    projectInfo: OpencodeProjectInfo,
  ): Promise<SessionEnrichment> {
    const enrichment: SessionEnrichment = {};

    await this.enrichSessionName(projectInfo, enrichment);
    await this.enrichTasks(projectInfo, enrichment);
    await this.enrichMessages(projectInfo, enrichment);

    return enrichment;
  }

  async getSubagents(
    projectInfo: OpencodeProjectInfo,
  ): Promise<SubagentInfo[]> {
    const snapshot = this.getCollectionSnapshot(projectInfo);
    const rows =
      snapshot.forest.directChildrenByRoot.get(projectInfo.sessionId) ?? [];
    return rows
      .map((row) => {
        const evidence = snapshot.evidenceBySession.get(row.id) ?? null;
        return {
          row,
          evidence,
          decision: this.getChildLifecycleDecision(row, evidence, snapshot.now),
        };
      })
      .filter(({ decision }) => decision !== "excluded")
      .map(({ row, evidence, decision }) => ({
        agentId: row.id,
        slug: undefined,
        description: undefined,
        sessionName: row.title || undefined,
        isActive: decision === "live",
        lastMessageTime: new Date(
          getChildLastMessageMs(row, evidence),
        ).toISOString(),
        launchTime: new Date(row.time_created).toISOString(),
      }))
      .sort((a, b) => b.launchTime.localeCompare(a.launchTime));
  }

  async getNotification(
    _projectInfo: OpencodeProjectInfo,
  ): Promise<NotificationMeta | null> {
    return null;
  }

  watchForChanges(onUpdate: () => void): {
    stop: () => void;
  } {
    let stopped = false;
    let statusWatcher: FSWatcher | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const statusLogPath = this.statusLogPath;
    const pollIntervalMs = this.pollIntervalMs;
    const statusPollIntervalMs = this.statusPollIntervalMs;

    function startPolling(interval: number): void {
      pollTimer = setInterval(() => {
        if (stopped) return;
        onUpdate();
      }, interval);
    }

    // Change-aware status poll: stat the log each tick and only fire
    // onUpdate() when the file actually changed. The baseline is captured
    // here (no update for it — the initial rescan covers startup). A stat
    // failure (file deleted) falls back to the unconditional 5s poll,
    // matching the watcher's deletion handling.
    function startChangeAwarePolling(interval: number): void {
      let baseline = statFileBasis(statusLogPath);
      pollTimer = setInterval(() => {
        if (stopped) return;
        const current = statFileBasis(statusLogPath);
        if (current === null) {
          if (pollTimer) clearInterval(pollTimer);
          startPolling(pollIntervalMs);
          return;
        }
        if (baseline === null || fileBasisChanged(baseline, current)) {
          baseline = current;
          onUpdate();
        }
      }, interval);
    }

    function startStatusWatcher(): void {
      if (stopped) return;
      const statusDir = dirname(statusLogPath);
      const basenameLog = basename(statusLogPath);
      let lastMtime = statSyncTerse(statusLogPath);
      try {
        statusWatcher = watch(statusDir, (_event, filename) => {
          if (stopped) return;
          if (filename !== null && filename !== basenameLog) return;
          if (filename === null) {
            const mtime = statSyncTerse(statusLogPath);
            if (mtime === null || mtime === lastMtime) return;
            lastMtime = mtime;
          }
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            if (stopped) return;
            if (existsSync(statusLogPath)) {
              onUpdate();
            } else {
              if (statusWatcher) {
                try {
                  statusWatcher.close();
                } catch {
                  // ignore
                }
                statusWatcher = null;
              }
              if (pollTimer) clearInterval(pollTimer);
              startPolling(pollIntervalMs);
            }
          }, DEBOUNCE_MS * 2);
        });
        statusWatcher.on("error", () => {
          if (statusWatcher) {
            try {
              statusWatcher.close();
            } catch {
              // ignore
            }
            statusWatcher = null;
          }
          if (!stopped) {
            if (pollTimer) clearInterval(pollTimer);
            startPolling(pollIntervalMs);
          }
        });
      } catch {
        // directory doesn't exist — polling only
      }
    }

    const fileExists = existsSync(statusLogPath);
    if (fileExists) {
      startStatusWatcher();
      startChangeAwarePolling(statusPollIntervalMs);
    } else {
      startPolling(pollIntervalMs);
    }

    return {
      stop: () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (statusWatcher) {
          try {
            statusWatcher.close();
          } catch {
            // ignore
          }
        }
      },
    };
  }

  projectKey(project: OpencodeProjectInfo): string {
    return `opencode::${project.sessionId}`;
  }

  private async enrichSessionName(
    projectInfo: OpencodeProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const sessionRow = this.db
        .prepare("SELECT title FROM session WHERE id = ?")
        .get(projectInfo.sessionId) as { title: string } | undefined;
      if (sessionRow?.title) {
        enrichment.sessionName = sessionRow.title;
      }
    } catch {
      log.warn("failed to read session title");
    }
  }

  private async enrichTasks(
    projectInfo: OpencodeProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const todos = this.db
        .prepare(
          "SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position",
        )
        .all(projectInfo.sessionId) as {
        content: string;
        status: string;
        priority: string;
        position: number;
      }[];
      if (todos.length > 0) {
        enrichment.tasks = todos.map((t) => ({
          id: String(t.position),
          subject: t.content,
          status: t.status,
          ...(t.status === "in_progress" ? { activeForm: t.content } : {}),
        }));
        enrichment.tasksDone = todos.filter(
          (t) => t.status === "completed",
        ).length;
        enrichment.tasksTotal = todos.length;
      }
    } catch {
      // skip
    }
  }

  private async enrichMessages(
    projectInfo: OpencodeProjectInfo,
    enrichment: SessionEnrichment,
  ): Promise<void> {
    try {
      const msgs = this.db
        .prepare(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 50",
        )
        .all(projectInfo.sessionId) as {
        id: string;
        data: string;
        time_created: number;
      }[];

      const partsByMsg = this.fetchPartsByMessage(msgs.map((m) => m.id));

      for (const msg of msgs) {
        const parsed = parseMessageData(msg.data);
        if (!parsed) continue;

        if (parsed.role === "assistant") {
          extractAssistantEnrichment(msg.id, parsed, partsByMsg, enrichment);
          if (
            enrichment.model &&
            enrichment.inputTokens !== undefined &&
            enrichment.latestAssistantActivity
          )
            break;
        }
      }

      for (const msg of msgs) {
        const parsed = parseMessageData(msg.data);
        if (!parsed) continue;

        if (parsed.role === "user") {
          extractUserActivity(msg.id, partsByMsg, enrichment);
          break;
        }
      }
    } catch {
      // message or part tables don't exist — skip enrichment
    }
  }

  private fetchPartsByMessage(
    msgIds: string[],
  ): Map<string, { data: string }[]> {
    const partsByMsg = new Map<string, { data: string }[]>();
    if (msgIds.length === 0) return partsByMsg;

    const placeholders = msgIds.map(() => "?").join(",");
    const partRows = this.db
      .prepare(
        `SELECT message_id, data FROM part WHERE message_id IN (${placeholders})`,
      )
      .all(...msgIds) as { message_id: string; data: string }[];
    for (const row of partRows) {
      const parts = partsByMsg.get(row.message_id);
      if (parts) {
        parts.push({ data: row.data });
      } else {
        partsByMsg.set(row.message_id, [{ data: row.data }]);
      }
    }
    return partsByMsg;
  }

  private loadStatusLogEvents(): StatusEvent[] | null {
    try {
      const s = statSync(this.statusLogPath);
      if (
        this.lastStatusLogDev === null ||
        s.dev !== this.lastStatusLogDev ||
        s.ino !== this.lastStatusLogIno ||
        this.lastStatusLogMtime === null ||
        s.mtimeMs !== this.lastStatusLogMtime ||
        s.size !== this.lastStatusLogSize
      ) {
        let raw: string;
        let slicedMidFile = false;
        if (s.size > MAX_FIRST_READ) {
          const tail = readTail(this.statusLogPath, s.size, MAX_FIRST_READ);
          raw = tail.raw;
          slicedMidFile = tail.slicedMidFile;
        } else {
          raw = readFileSync(this.statusLogPath, "utf-8");
        }
        const records = parseStatusLogRecords(raw, slicedMidFile);
        const events: StatusEvent[] = [];
        let heartbeatMs: number | null = null;
        for (const record of records) {
          if (isStatusEvent(record)) {
            events.push(record);
          } else if (isPluginHeartbeat(record)) {
            const ts = Date.parse(record.timestamp);
            if (
              !Number.isNaN(ts) &&
              (heartbeatMs === null || ts >= heartbeatMs)
            ) {
              heartbeatMs = ts;
            }
          }
        }
        this.statusLogEvents = events;
        this.statusEventIndex = null;
        this.lastPluginHeartbeatMs = heartbeatMs;
        this.lastStatusLogDev = s.dev;
        this.lastStatusLogIno = s.ino;
        this.lastStatusLogMtime = s.mtimeMs;
        this.lastStatusLogSize = s.size;
      }
    } catch {
      this.lastStatusLogDev = null;
      this.lastStatusLogIno = null;
      this.lastStatusLogMtime = null;
      this.lastStatusLogSize = null;
      this.statusLogEvents = null;
      this.statusEventIndex = null;
      this.lastPluginHeartbeatMs = null;
      return null;
    }

    return this.statusLogEvents ?? [];
  }

  private isPluginHealthy(now: number): boolean {
    return (
      this.lastPluginHeartbeatMs !== null &&
      now - this.lastPluginHeartbeatMs < PLUGIN_HEALTH_THRESHOLD_MS
    );
  }

  private getStatusEventIndex(): StatusEventIndex {
    const events = this.loadStatusLogEvents();
    if (this.statusEventIndex === null) {
      const eventsBySession = new Map<string, StatusEvent[]>();
      if (events === null) return { eventsBySession };
      for (const event of events) {
        const grouped = eventsBySession.get(event.session_id);
        if (grouped) grouped.push(event);
        else eventsBySession.set(event.session_id, [event]);
      }
      for (const grouped of eventsBySession.values()) {
        const indexed = grouped.map((event, index) => ({
          event,
          index,
          timestampMs: new Date(event.timestamp).getTime(),
        }));
        indexed.sort((a, b) => {
          const aValid = Number.isFinite(a.timestampMs);
          const bValid = Number.isFinite(b.timestampMs);
          if (aValid && bValid)
            return a.timestampMs - b.timestampMs || a.index - b.index;
          if (aValid) return -1;
          if (bValid) return 1;
          return a.index - b.index;
        });
        grouped.splice(0, grouped.length, ...indexed.map(({ event }) => event));
      }
      this.statusEventIndex = { eventsBySession };
    }

    return this.statusEventIndex;
  }

  private createCollectionSnapshot(): CollectionSnapshot {
    const now = Date.now();
    const forest = this.loadForestSnapshot();
    const statusEventIndex = this.getStatusEventIndex();
    const evidenceBySession = new Map<string, SessionEvidence>();
    for (const session of [
      ...forest.rootsById.values(),
      ...[...forest.descendantsByRoot.values()].flat(),
    ]) {
      evidenceBySession.set(
        session.id,
        buildSessionEvidence(
          session.id,
          statusEventIndex.eventsBySession.get(session.id) ?? [],
          now,
          session.latestUserMessageMs,
          session.latestSqliteActivityMs,
          session.latestActiveToolMs,
        ),
      );
    }

    const aggregatesByRoot = new Map<string, RootAggregate>();
    for (const root of forest.rootsById.values()) {
      const descendants = forest.descendantsByRoot.get(root.id) ?? [];
      const sessions = [root, ...descendants];
      const rootStatus = evidenceBySession.get(root.id)?.state ?? null;
      const recoveredGenerationStartMs =
        evidenceBySession.get(root.id)?.recoveredGenerationStartMs ?? null;
      const hasFreshBlocker = sessions.some((session) =>
        (evidenceBySession.get(session.id)?.blockers ?? []).some(
          (blocker) =>
            blocker.timestampMs > now - PERMISSION_STALE_MS &&
            (session.id === root.id ||
              recoveredGenerationStartMs === null ||
              blocker.timestampMs > recoveredGenerationStartMs),
        ),
      );
      const hasLiveDescendant = (
        forest.descendantsByRoot.get(root.id) ?? []
      ).some((descendant) => {
        if (descendant.time_archived !== null) return false;
        return (
          this.getChildLifecycleDecision(
            descendant,
            evidenceBySession.get(descendant.id) ?? null,
            now,
            recoveredGenerationStartMs,
          ) === "live"
        );
      });

      let state: SessionState;
      if (rootStatus === "closed" || rootStatus === "error") {
        state = rootStatus;
      } else if (hasFreshBlocker) {
        state = "waiting_for_permission";
      } else if (rootStatus === "running") {
        state = "running";
      } else if (root.time_archived !== null) {
        state = "stopped";
      } else if (rootStatus === "stopped") {
        state = hasLiveDescendant ? "running" : "stopped";
      } else if (now - root.time_updated < OPENCODE_ACTIVE_THRESHOLD_MS) {
        state = "running";
      } else {
        state = hasLiveDescendant ? "running" : "stopped";
      }

      const terminalTimestampMs =
        state === "error" || state === "closed"
          ? evidenceBySession.get(root.id)?.terminalTimestampMs
          : null;
      const lastUpdatedMs =
        terminalTimestampMs ??
        sessions.reduce((latest, session) => {
          const activity = evidenceBySession.get(session.id)?.latestActivityMs;
          return Math.max(
            latest,
            session.id === root.id
              ? session.time_updated
              : Number.NEGATIVE_INFINITY,
            activity ?? Number.NEGATIVE_INFINITY,
          );
        }, root.time_updated);
      aggregatesByRoot.set(root.id, { state, lastUpdatedMs });
    }

    return {
      now,
      forest,
      statusEventIndex,
      evidenceBySession,
      aggregatesByRoot,
    };
  }

  private getCollectionSnapshot(
    projectInfo: OpencodeProjectInfo,
  ): CollectionSnapshot {
    const cached = this.collectionByProject.get(projectInfo);
    if (cached) return cached;
    const snapshot = this.createCollectionSnapshot();
    this.collectionByProject.set(projectInfo, snapshot);
    return snapshot;
  }

  private isLiveChildLifecycleEvidence(
    evidence: ChildLifecycleEvidence,
    now: number,
  ): boolean {
    if (evidence.isTerminal) return false;
    const timeout =
      evidence.event.event === "PermissionRequest"
        ? PERMISSION_STALE_MS
        : SUBAGENT_LIFECYCLE_TIMEOUT_MS;
    return evidence.timestampMs >= now - timeout;
  }

  private getChildLifecycleDecision(
    row: ChildLifecycleRow,
    evidence: SessionEvidence | null,
    now: number,
    generationStartMs: number | null = null,
  ): ChildLifecycleDecision {
    const lifecycle = evidence?.lifecycle ?? null;
    const latestEvidenceMs =
      evidence?.latestActivityMs ??
      lifecycle?.timestampMs ??
      Math.max(row.time_created, row.time_updated);
    if (generationStartMs !== null && latestEvidenceMs <= generationStartMs) {
      return "excluded";
    }
    if (evidence?.mode === "hard_terminal" || evidence?.mode === "idle") {
      if (lifecycle === null) return "excluded";
      return lifecycle.timestampMs >= now - SUBAGENT_EXPIRY_MS
        ? "terminal_retained"
        : "excluded";
    }
    if (evidence?.state !== null) return "live";
    if (lifecycle === null) {
      return latestEvidenceMs > now - SUBAGENT_LIFECYCLE_TIMEOUT_MS
        ? "live"
        : "excluded";
    }
    if (lifecycle.isTerminal) {
      return lifecycle.timestampMs >= now - SUBAGENT_EXPIRY_MS
        ? "terminal_retained"
        : "excluded";
    }
    return this.isLiveChildLifecycleEvidence(lifecycle, now)
      ? "live"
      : "excluded";
  }

  /** Captures visible roots and their descendants in one cycle-safe query. */
  private loadForestSnapshot(): ForestSnapshot {
    const now = Date.now();
    const cutoff = now - OPENCODE_ACTIVE_THRESHOLD_MS;
    // Read the status log before gating so the plugin heartbeat timestamp is
    // populated; the gate below relies on it.
    this.loadStatusLogEvents();

    // Gate the heavy JSON CTEs on plugin liveness. When the plugin is
    // unhealthy every session needs inference, so run the full query
    // (forest + CTEs) directly. When healthy, run a cheap forest-only query
    // first and only pay for the CTEs if some session lacks fresh evidence.
    let rows: Array<ForestSession & { root_id: string }>;
    if (!this.isPluginHealthy(now)) {
      rows = this.loadForestRowsWithInference(cutoff, null);
    } else {
      const baseRows = this.loadForestRows(false, false, cutoff, null);
      const inferenceSessions = this.resolveInferenceSessionIds(now, baseRows);
      rows =
        inferenceSessions.size === 0
          ? baseRows
          : this.loadForestRowsWithInference(cutoff, [...inferenceSessions]);
    }

    const rootsById = new Map<string, ForestSession>();
    const childrenByParent = new Map<string, ForestSession[]>();
    for (const row of rows) {
      if (row.id === row.root_id) {
        rootsById.set(row.id, row);
        continue;
      }
      if (row.parent_id !== null) {
        const children = childrenByParent.get(row.parent_id);
        if (children) children.push(row);
        else childrenByParent.set(row.parent_id, [row]);
      }
    }
    const descendantsByRoot = new Map<string, ForestSession[]>();
    const directChildrenByRoot = new Map<string, ForestSession[]>();
    for (const root of rootsById.values()) {
      const descendants: ForestSession[] = [];
      const directChildren: ForestSession[] = [];
      const collectDescendants = (parentId: string, isDirectChild: boolean) => {
        for (const child of childrenByParent.get(parentId) ?? []) {
          if (child.time_archived !== null) continue;
          descendants.push(child);
          if (isDirectChild) directChildren.push(child);
          collectDescendants(child.id, false);
        }
      };
      collectDescendants(root.id, true);
      if (descendants.length > 0) descendantsByRoot.set(root.id, descendants);
      if (directChildren.length > 0) {
        directChildrenByRoot.set(root.id, directChildren);
      }
    }

    return { rootsById, descendantsByRoot, directChildrenByRoot };
  }

  /**
   * Runs the forest query with the JSON inference CTEs, narrowing to
   * `sessionFilter` when provided. Falls back gracefully when the message or
   * part table is absent.
   */
  private loadForestRowsWithInference(
    cutoff: number,
    sessionFilter: string[] | null,
  ): Array<ForestSession & { root_id: string }> {
    const includePersistedUserMessages = this.shouldLoadPersistedUserMessages();
    const includePartActivity =
      includePersistedUserMessages && this.shouldLoadPartActivity();
    try {
      const rows = this.loadForestRows(
        includePersistedUserMessages,
        includePartActivity,
        cutoff,
        sessionFilter,
      );
      if (includePersistedUserMessages) {
        this.messageTableAvailable = true;
        this.messageTableSchemaVersion = null;
      }
      return rows;
    } catch (error) {
      if (isMissingPartTable(error) && includePersistedUserMessages) {
        const partTable = this.readPartTableSnapshot();
        const rows = this.loadForestRows(
          true,
          partTable.exists,
          cutoff,
          sessionFilter,
        );
        this.messageTableAvailable = true;
        this.messageTableSchemaVersion = null;
        this.partTableAvailable = partTable.exists;
        this.partTableSchemaVersion = partTable.exists
          ? null
          : partTable.schemaVersion;
        return rows;
      }
      if (isMissingMessageTable(error)) {
        const schemaVersion = this.readSchemaVersion();
        if (this.messageTableExists()) {
          const rows = this.loadForestRows(
            true,
            this.shouldLoadPartActivity(),
            cutoff,
            sessionFilter,
          );
          this.messageTableAvailable = true;
          this.messageTableSchemaVersion = null;
          return rows;
        }
        this.messageTableAvailable = false;
        this.messageTableSchemaVersion = schemaVersion;
        return this.loadForestRows(false, false, cutoff, null);
      }
      throw error;
    }
  }

  /**
   * Sessions that need the JSON inference CTEs: those lacking fresh plugin
   * evidence (no events, or last event ≥ 30s old), plus any session with a
   * hard-terminal event in its history — recovering from a StopFailure /
   * SessionEnd depends on the persisted user-message evidence that only the
   * CTEs supply, even when the latest event is fresh.
   */
  private resolveInferenceSessionIds(
    now: number,
    rows: Array<ForestSession & { root_id: string }>,
  ): Set<string> {
    const index = this.getStatusEventIndex();
    const result = new Set<string>();
    for (const row of rows) {
      const events = index.eventsBySession.get(row.id);
      if (!events || events.length === 0) {
        result.add(row.id);
        continue;
      }
      const latest = events[events.length - 1];
      const ts = new Date(latest.timestamp).getTime();
      const lacksFreshEvidence =
        !Number.isFinite(ts) || now - ts >= OPENCODE_ACTIVE_THRESHOLD_MS;
      const hasHardTerminal = events.some((event) =>
        isHardTerminalEvidence(event),
      );
      if (lacksFreshEvidence || hasHardTerminal) {
        result.add(row.id);
      }
    }
    return result;
  }

  private shouldLoadPersistedUserMessages(): boolean {
    if (this.messageTableAvailable !== false) return true;
    const schemaVersion = this.readSchemaVersion();
    if (schemaVersion === this.messageTableSchemaVersion) return false;
    this.messageTableAvailable = null;
    this.messageTableSchemaVersion = null;
    return true;
  }

  private shouldLoadPartActivity(): boolean {
    if (this.partTableAvailable !== false) return true;
    const schemaVersion = this.readSchemaVersion();
    if (schemaVersion === this.partTableSchemaVersion) return false;
    this.partTableAvailable = null;
    this.partTableSchemaVersion = null;
    return true;
  }

  private readSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    return row.schema_version;
  }

  private readPartTableSnapshot(): {
    exists: boolean;
    schemaVersion: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT schema_version FROM pragma_schema_version) AS schemaVersion,
           EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'part'
           ) AS partTableExists`,
      )
      .get() as { schemaVersion: number; partTableExists: number };
    return {
      exists: row.partTableExists !== 0,
      schemaVersion: row.schemaVersion,
    };
  }

  private messageTableExists(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'",
        )
        .get() !== undefined
    );
  }

  private loadForestRows(
    includePersistedUserMessages: boolean,
    includePartActivity: boolean,
    cutoff: number,
    sessionFilter: string[] | null,
  ): Array<ForestSession & { root_id: string }> {
    const filterClause =
      sessionFilter !== null && sessionFilter.length > 0
        ? `AND forest.session_id IN (${sessionFilter.map(() => "?").join(", ")})`
        : "";
    const userMessageCte = includePersistedUserMessages
      ? `, root_user_messages(session_id, latestUserMessageMs) AS (
            SELECT m.session_id, MAX(m.time_created)
            FROM message m
            JOIN forest ON forest.session_id = m.session_id
            WHERE 1 = 1
              ${filterClause}
              AND m.time_created > ?
              AND CASE WHEN json_valid(m.data)
                THEN json_extract(m.data, '$.role')
              END = 'user'
            GROUP BY m.session_id
          )`
      : "";
    const latestUserMessageColumn = includePersistedUserMessages
      ? "root_user_messages.latestUserMessageMs"
      : "NULL";
    const userMessageJoin = includePersistedUserMessages
      ? "LEFT JOIN root_user_messages ON root_user_messages.session_id = s.id"
      : "";
    const partActivityRows = includePartActivity
      ? `UNION ALL
               SELECT p.session_id, p.time_updated, p.data, 'part' AS kind
               FROM part p
               JOIN forest ON forest.session_id = p.session_id
               WHERE p.time_updated > ?
                 ${filterClause}`
      : "";
    const sqliteActivityCte = includePersistedUserMessages
      ? `, sqlite_activity(session_id, latestSqliteActivityMs, latestActiveToolMs) AS (
            SELECT activity.session_id,
                   MAX(activity.time_updated),
                   MAX(CASE
                      WHEN activity.kind = 'part'
                        AND CASE WHEN json_valid(activity.data)
                          THEN json_extract(activity.data, '$.type')
                        END = 'tool'
                        AND COALESCE(
                          CASE WHEN json_valid(activity.data)
                            THEN json_extract(activity.data, '$.state')
                          END,
                          CASE WHEN json_valid(activity.data)
                            THEN json_extract(activity.data, '$.status')
                          END
                        ) IN ('pending', 'running')
                      THEN activity.time_updated
                    END)
            FROM (
              SELECT m.session_id, m.time_updated, NULL AS data, 'message' AS kind
              FROM message m
              JOIN forest ON forest.session_id = m.session_id
              WHERE m.time_updated > ?
                ${filterClause}
              ${partActivityRows}
            ) activity
            GROUP BY activity.session_id
          )`
      : "";
    const sqliteActivityColumns = includePersistedUserMessages
      ? "sqlite_activity.latestSqliteActivityMs, sqlite_activity.latestActiveToolMs"
      : "NULL, NULL";
    const sqliteActivityJoin = includePersistedUserMessages
      ? "LEFT JOIN sqlite_activity ON sqlite_activity.session_id = s.id"
      : "";

    // Params follow the SQL placeholder order: root_user_messages (filter,
    // cutoff), then the sqlite_activity message branch (cutoff, filter), then
    // the part branch (cutoff, filter) when parts are included.
    const params: (string | number)[] = [];
    if (includePersistedUserMessages) {
      if (sessionFilter !== null && sessionFilter.length > 0) {
        params.push(...sessionFilter);
      }
      params.push(cutoff);
      params.push(cutoff);
      if (sessionFilter !== null && sessionFilter.length > 0) {
        params.push(...sessionFilter);
      }
      if (includePartActivity) {
        params.push(cutoff);
        if (sessionFilter !== null && sessionFilter.length > 0) {
          params.push(...sessionFilter);
        }
      }
    }

    return this.db
      .prepare(
        `WITH RECURSIVE forest(root_id, session_id) AS (
            SELECT id, id FROM session
            WHERE time_archived IS NULL AND parent_id IS NULL
            UNION
             SELECT forest.root_id, child.id
             FROM forest
             JOIN session child ON child.parent_id = forest.session_id
           )${userMessageCte}${sqliteActivityCte}
            SELECT forest.root_id, s.id, s.parent_id, s.title, s.directory,
                   p.name AS projectName, s.time_created, s.time_updated, s.time_archived,
                   ${latestUserMessageColumn} AS latestUserMessageMs,
                   ${sqliteActivityColumns}
            FROM forest
            JOIN session s ON s.id = forest.session_id
            JOIN project p ON p.id = s.project_id
            ${userMessageJoin}
            ${sqliteActivityJoin}`,
      )
      .all(...params) as Array<ForestSession & { root_id: string }>;
  }

  private assertParentIdIndex(): void {
    const indexes = this.db.prepare("PRAGMA index_list('session')").all() as {
      name: string;
    }[];
    for (const { name } of indexes) {
      const columns = this.db
        .prepare(`PRAGMA index_info(${quoteSqlIdentifier(name)})`)
        .all() as { seqno: number; name: string }[];
      if (columns.sort((a, b) => a.seqno - b.seqno)[0]?.name === "parent_id") {
        return;
      }
    }
    throw new Error("OpenCode session table requires an index on parent_id");
  }
}

function getChildLastMessageMs(
  row: ChildLifecycleRow,
  evidence: SessionEvidence | null,
): number {
  if (evidence?.mode === "active" && evidence.latestActivityMs !== null) {
    return evidence.latestActivityMs;
  }
  return evidence?.lifecycle?.timestampMs ?? row.time_updated;
}

function readTail(
  path: string,
  fileSize: number,
  maxBytes: number,
): { raw: string; slicedMidFile: boolean } {
  const byteCount = Math.min(fileSize, maxBytes);
  const startOffset = fileSize - byteCount;
  const buffer = Buffer.allocUnsafe(byteCount);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, byteCount, startOffset);
    let slicedMidFile = false;
    if (startOffset > 0) {
      const precedingByte = Buffer.allocUnsafe(1);
      readSync(fd, precedingByte, 0, 1, startOffset - 1);
      slicedMidFile = precedingByte[0] !== 0x0a;
    }
    return { raw: buffer.toString("utf-8", 0, bytesRead), slicedMidFile };
  } finally {
    closeSync(fd);
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isMissingMessageTable(error: unknown): boolean {
  return error instanceof Error && /no such table: message/.test(error.message);
}

function isMissingPartTable(error: unknown): boolean {
  return error instanceof Error && /no such table: part/.test(error.message);
}

function buildSessionEvidence(
  sessionId: string,
  events: StatusEvent[],
  now: number,
  latestUserMessageMs: number | null,
  latestSqliteActivityMs: number | null,
  latestActiveToolMs: number | null,
): SessionEvidence {
  const blockers = new Map<string, Blocker>();
  let latestActivityMs: number | null = null;
  let lifecycle: ChildLifecycleEvidence | null = null;
  let mode: LifecycleMode = "active";
  let state: SessionState | null = null;
  let terminalTimestampMs: number | null = null;
  let recoveredGenerationStartMs: number | null = null;

  const timeline = buildGenerationTimeline(events, latestUserMessageMs);
  for (const evidence of timeline) {
    const isPersistedUserMessage = evidence.type === "persisted_user_message";
    const rawEvent = isPersistedUserMessage ? null : evidence.event;
    const timestampMs = evidence.timestampMs;
    const isReactivation =
      isPersistedUserMessage ||
      (rawEvent !== null && isGenerationReactivation(rawEvent));
    const isIdleReactivation =
      isPersistedUserMessage ||
      (rawEvent !== null && isIdleReactivationEvidence(rawEvent));
    const isHardTerminal =
      rawEvent !== null && isHardTerminalEvidence(rawEvent);

    if (mode === "hard_terminal") {
      if (state === "closed") continue;
      if (isHardTerminal) {
        // A later Error can refresh its barrier; a later Closed supersedes it.
      } else if (
        !isReactivation ||
        timestampMs <= (terminalTimestampMs ?? Number.POSITIVE_INFINITY)
      ) {
        continue;
      } else {
        mode = "active";
        state = null;
        blockers.clear();
        latestActivityMs = null;
        lifecycle = null;
        terminalTimestampMs = null;
        recoveredGenerationStartMs = timestampMs;
      }
    } else if (mode === "idle" && !isIdleReactivation && !isHardTerminal) {
      continue;
    } else if (mode === "idle") {
      mode = "active";
      blockers.clear();
      latestActivityMs = null;
      lifecycle = null;
    }

    if (isReactivation) {
      blockers.clear();
    }

    if (isPersistedUserMessage) {
      latestActivityMs = Math.max(latestActivityMs ?? timestampMs, timestampMs);
      state = "running";
      continue;
    }

    if (rawEvent === null) continue;
    const event = normalizeOpencodeStatusEvent(rawEvent);
    const isTerminal =
      event.event === "Stop" ||
      event.event === "StopFailure" ||
      event.event === "SessionEnd";
    const isActivity =
      event.event === "PostToolUse" ||
      event.event === "UserPromptSubmit" ||
      event.event === "session.created";
    const isPermissionWait = event.event === "PermissionRequest";

    if (isActivity || isPermissionWait) {
      latestActivityMs = Math.max(latestActivityMs ?? timestampMs, timestampMs);
      state = isPermissionWait ? "waiting_for_permission" : "running";
    }
    if (isTerminal || isActivity || isPermissionWait) {
      lifecycle = { event, timestampMs, isTerminal };
    }

    if (isTerminal) {
      blockers.clear();
      state =
        event.event === "StopFailure"
          ? "error"
          : event.event === "SessionEnd"
            ? "closed"
            : "stopped";
      mode = event.event === "Stop" ? "idle" : "hard_terminal";
      terminalTimestampMs = mode === "hard_terminal" ? timestampMs : null;
      if (mode === "hard_terminal") recoveredGenerationStartMs = null;
      continue;
    }
    const blockerLifecycle = getBlockerLifecycle(rawEvent);
    if (blockerLifecycle === null) continue;
    const requestId = normalizeRequestId(rawEvent.request_id);
    const key = blockerKey(blockerLifecycle.kind, requestId);
    if (blockerLifecycle.action === "ask") {
      blockers.set(key, {
        sessionId,
        kind: blockerLifecycle.kind,
        requestId,
        timestampMs,
      });
    } else {
      if (!blockers.delete(key) && requestId !== null) {
        blockers.delete(blockerKey(blockerLifecycle.kind, null));
      }
    }
  }

  const hasFreshSqliteActivity = isFreshSqliteActivity(
    latestSqliteActivityMs,
    now,
  );
  const hasFreshActiveTool = isFreshSqliteActivity(latestActiveToolMs, now);
  if (mode === "active" && hasFreshSqliteActivity) {
    latestActivityMs = Math.max(
      latestActivityMs ?? Number.NEGATIVE_INFINITY,
      latestSqliteActivityMs,
    );
    if (state === null || hasFreshActiveTool) state = "running";
  }

  return {
    mode,
    state:
      mode === "hard_terminal" || mode === "idle"
        ? state
        : latestActivityMs !== null &&
            latestActivityMs > now - OPENCODE_ACTIVE_THRESHOLD_MS
          ? state
          : null,
    blockers: [...blockers.values()].filter(
      (blocker) => blocker.timestampMs > now - PERMISSION_STALE_MS,
    ),
    latestActivityMs,
    lifecycle,
    terminalTimestampMs,
    recoveredGenerationStartMs,
  };
}

function buildGenerationTimeline(
  events: StatusEvent[],
  latestUserMessageMs: number | null,
): GenerationEvidence[] {
  const timeline: GenerationEvidence[] = [];
  for (const [order, event] of events.entries()) {
    if (event.event === "Notification" || event.event === "SubagentStop") {
      continue;
    }
    const timestampMs = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestampMs)) continue;
    timeline.push({ type: "status", event, timestampMs, order });
  }
  if (latestUserMessageMs !== null && Number.isFinite(latestUserMessageMs)) {
    timeline.push({
      type: "persisted_user_message",
      timestampMs: latestUserMessageMs,
    });
  }
  timeline.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (a.type === "status" && b.type === "status") {
      return a.order - b.order;
    }
    return a.type === "status" ? -1 : b.type === "status" ? 1 : 0;
  });
  return timeline;
}

function blockerKey(kind: BlockerKind, requestId: string | null): string {
  return `${kind}\u0000${requestId ?? LEGACY_REQUEST_SLOT}`;
}

function normalizeRequestId(requestId: string | undefined): string | null {
  return requestId && requestId.length > 0 ? requestId : null;
}

function isGenerationReactivation(event: StatusEvent): boolean {
  return (
    event.event === "chat.message" ||
    event.event === "UserPromptSubmit" ||
    event.event === "session.created"
  );
}

function isIdleReactivationEvidence(event: StatusEvent): boolean {
  return (
    isGenerationReactivation(event) ||
    event.event === "session.status" ||
    event.event === "message.part.updated"
  );
}

function isFreshSqliteActivity(
  timestampMs: number | null,
  now: number,
): timestampMs is number {
  return (
    timestampMs !== null &&
    Number.isFinite(timestampMs) &&
    timestampMs <= now &&
    now - timestampMs < OPENCODE_ACTIVE_THRESHOLD_MS
  );
}

function isHardTerminalEvidence(event: StatusEvent): boolean {
  const normalized = normalizeOpencodeStatusEvent(event);
  return (
    normalized.event === "StopFailure" || normalized.event === "SessionEnd"
  );
}

function getBlockerLifecycle(event: StatusEvent): {
  action: "ask" | "resolve";
  kind: BlockerKind;
} | null {
  if (event.event === "question.asked")
    return { action: "ask", kind: "question" };
  if (event.event === "permission.asked" || event.event === "permission.ask") {
    return { action: "ask", kind: "permission" };
  }
  if (
    event.event === "PermissionRequest" ||
    event.state === "waiting_for_permission"
  ) {
    return { action: "ask", kind: event.blocker_kind ?? "permission" };
  }
  if (event.event === "UserPromptSubmit") {
    return { action: "resolve", kind: "permission" };
  }
  if (
    event.event === "question.replied" ||
    event.event === "question.rejected"
  ) {
    return { action: "resolve", kind: "question" };
  }
  if (
    event.event === "permission.replied" ||
    event.event === "permission.rejected"
  ) {
    return { action: "resolve", kind: "permission" };
  }
  return null;
}

function normalizeOpencodeStatusEvent(event: StatusEvent): StatusEvent {
  if (
    event.event === "permission.ask" ||
    event.event === "permission.asked" ||
    event.event === "question.asked" ||
    event.state === "waiting_for_permission"
  ) {
    return {
      ...event,
      event: "PermissionRequest",
      state: "waiting_for_permission",
    };
  }

  if (
    event.event === "permission.replied" ||
    event.event === "permission.rejected" ||
    event.event === "question.replied" ||
    event.event === "question.rejected"
  ) {
    return { ...event, event: "UserPromptSubmit", state: "running" };
  }

  if (event.state === "running") {
    return { ...event, event: "PostToolUse", state: "running" };
  }

  if (event.state === "closed") {
    return { ...event, event: "SessionEnd", state: "closed" };
  }

  if (event.state === "error") {
    return { ...event, event: "StopFailure", state: "error" };
  }

  if (event.state === "stopped") {
    return { ...event, event: "Stop", state: "stopped" };
  }

  return event;
}

/**
 * Fills model, token counts, and assistant activity from a single assistant message.
 * Stops updating fields once they are already populated on the enrichment object.
 */
function extractAssistantEnrichment(
  msgId: string,
  parsed: {
    modelID?: string;
    tokens?: { input?: number; output?: number; cache?: { read?: number } };
  },
  partsByMsg: Map<string, { data: string }[]>,
  enrichment: SessionEnrichment,
): void {
  if (!enrichment.model && typeof parsed.modelID === "string") {
    enrichment.model = parsed.modelID;
  }

  if (enrichment.inputTokens === undefined) {
    const tokens = parsed.tokens;
    if (tokens) {
      const cacheRead = tokens.cache?.read ?? 0;
      const deltaInput = tokens.input ?? 0;
      const deltaOutput = tokens.output ?? 0;
      if (cacheRead > 0 || deltaInput > 0) {
        enrichment.inputTokens = cacheRead + deltaInput;
      }
      if (deltaOutput > 0) {
        enrichment.outputTokens = deltaOutput;
      }
    }
  }

  if (!enrichment.latestAssistantActivity) {
    const parts = partsByMsg.get(msgId) ?? [];
    let text: string | undefined;
    let tool: string | undefined;
    for (const part of parts) {
      const p = parsePartData(part.data);
      if (!p) continue;
      if (p.type === "text") {
        text = p.text;
      } else if (p.type === "tool") {
        tool = p.tool;
      }
      if (text && tool) break;
    }
    if (text !== undefined || tool !== undefined) {
      enrichment.latestAssistantActivity = {
        text: text ? text.slice(0, 200) : undefined,
        tool,
      };
    }
  }
}

/**
 * Fills latestUserActivity from the parts of a single user message.
 * Only updates the enrichment if not already populated.
 */
function extractUserActivity(
  msgId: string,
  partsByMsg: Map<string, { data: string }[]>,
  enrichment: SessionEnrichment,
): void {
  if (enrichment.latestUserActivity) return;

  const parts = partsByMsg.get(msgId) ?? [];
  for (const part of parts) {
    const p = parsePartData(part.data);
    if (!p) continue;
    if (p.type === "text") {
      enrichment.latestUserActivity = {
        text: p.text.slice(0, 200),
        isCommand: false,
      };
      break;
    }
  }
}
