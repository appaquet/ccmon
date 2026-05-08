import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createBackends } from "./backends";
import { collectBackendStates } from "./backends/collect-states";
import { loadConfig, mergeCliOverrides } from "./config";
import {
  DEFAULT_CLAUDE_DIR,
  disambiguateProjectNames,
  filterStaleProjects,
  scanProjects,
} from "./project-utils";
import { startServer } from "./server";
import type { StatusEvent } from "./session-core";
import {
  mapHookEventToState,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
  writeSubagentStatus,
} from "./status-writer";
import type { ProjectState } from "./types";

function exit(code: number): never {
  process.exit(code);
}

const claudeDir = process.env.CLAUDE_PROJECTS_DIR ?? DEFAULT_CLAUDE_DIR;

const VERSION = "0.1.0";

function parseStringFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function parseNumberFlag(argv: string[], name: string): number | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = parseFloat(argv[idx + 1] ?? "");
  return Number.isNaN(value) ? undefined : value;
}

const subcommand = process.argv[2];

if (subcommand === "--version" || subcommand === "-v") {
  process.stdout.write(`ccmon ${VERSION}\n`);
  exit(0);
}

const projectFilter = parseStringFlag(process.argv, "--project");
if (process.argv.includes("--project") && projectFilter === null) {
  process.stderr.write("Error: --project requires a value\n");
  exit(1);
}

const maxAgeArg = parseNumberFlag(process.argv, "--max-age");
if (process.argv.includes("--max-age") && maxAgeArg === undefined) {
  process.stderr.write("Error: --max-age requires a valid number\n");
  exit(1);
}

const noFilter = process.argv.includes("--no-filter");

const config = mergeCliOverrides(loadConfig(), {
  maxInactivityHours: noFilter ? Infinity : maxAgeArg,
});

if (subcommand === "dump") {
  const watch = process.argv.includes("--watch");

  if (watch) {
    await runDumpWatch();
  } else {
    await runDump();
  }
} else if (subcommand === "status") {
  await runStatus();
} else if (subcommand === "sub") {
  await runSub();
} else if (subcommand === "serve") {
  const port = parseNumberFlag(process.argv, "--port");
  if (process.argv.includes("--port") && port === undefined) {
    process.stderr.write("Error: --port requires a valid number\n");
    exit(1);
  }

  const host = parseStringFlag(process.argv, "--host");
  if (process.argv.includes("--host") && host === null) {
    process.stderr.write("Error: --host requires a value\n");
    exit(1);
  }

  const serveConfig = mergeCliOverrides(config, {
    port,
    host: host ?? undefined,
  });
  const { backends, close } = createBackends(serveConfig);
  const { port: resolvedPort, stop } = startServer({
    port: serveConfig.port,
    hostname: serveConfig.host,
    maxInactivityHours: serveConfig.maxInactivityHours,
    backends,
  });
  process.stdout.write(
    `ccmon server listening on http://${serveConfig.host}:${resolvedPort}\n`,
  );

  process.on("SIGINT", () => {
    stop();
    close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    close();
    process.exit(0);
  });
} else {
  process.stderr.write(
    `Usage: ccmon <subcommand>

Subcommands:
  dump                   Print current session state as JSON
  dump --watch           Watch for changes and print updates
  dump --max-age <hours> Override maxInactivityHours from config
  dump --no-filter       Disable inactivity filter
  status                 Read hook event from stdin and write status file
  serve                  Start HTTP + WebSocket server
  serve --host <addr>    Listen on custom host (default: 0.0.0.0)
  serve --port <N>       Listen on custom port (default: 8080)
  sub                    Connect to running server, stream state as NDJSON
  sub --host <addr>      Connect to custom host (default: localhost)
  sub --port <N>         Connect to custom port (default: 8080)

Supports Claude Code and OpenCode monitoring. Configure backends in
~/.config/ccmon/config.json (default: Claude Code only).
`,
  );
  process.exit(1);
}

async function runDump(): Promise<void> {
  try {
    const { backends, close } = createBackends(config);
    const projectMap = await collectBackendStates(backends);

    const allProjects = [...projectMap.values()];
    disambiguateProjectNames(allProjects);
    const state = filterStaleProjects(allProjects, config.maxInactivityHours);

    if (projectFilter !== null) {
      const match =
        state.find(
          (p) =>
            p.projectName === projectFilter ||
            basename(p.cwd) === projectFilter,
        ) ?? null;
      if (match !== null) {
        console.log(JSON.stringify(match, null, 2));
      }
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    close();
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

async function runDumpWatch(): Promise<void> {
  const { backends, close } = createBackends(config);
  const projectMap = new Map<string, ProjectState>();

  function formatWatchOutput(): string {
    const allProjects = [...projectMap.values()];
    disambiguateProjectNames(allProjects);
    const state = filterStaleProjects(allProjects, config.maxInactivityHours);
    if (projectFilter !== null) {
      const match =
        state.find(
          (p) =>
            p.projectName === projectFilter ||
            basename(p.cwd) === projectFilter,
        ) ?? null;
      return match !== null ? JSON.stringify(match, null, 2) : "";
    }
    return JSON.stringify(state, null, 2);
  }

  try {
    const initial = await collectBackendStates(backends);
    for (const [k, v] of initial) projectMap.set(k, v);
    const output = formatWatchOutput();
    if (output) console.log(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error getting initial state: ${message}\n`);
    process.exit(1);
  }

  const watcherStops: Array<{ stop: () => void }> = [];
  for (const backend of backends) {
    const watcher = backend.watchForChanges(async () => {
      try {
        const backendStates = await collectBackendStates([backend]);
        for (const [k, v] of backendStates) projectMap.set(k, v);
        const output = formatWatchOutput();
        if (output) console.log(output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error getting state update: ${message}\n`);
      }
    });
    watcherStops.push(watcher);
  }

  process.on("SIGINT", () => {
    for (const w of watcherStops) w.stop();
    close();
    process.exit(0);
  });
}

async function runStatus(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error reading stdin: ${message}\n`);
    exit(1);
  }

  if (!raw.trim()) {
    process.stderr.write("Error: empty stdin — expected hook JSON payload\n");
    exit(1);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "Error: invalid JSON on stdin — expected hook JSON payload\n",
    );
    exit(1);
  }

  if (!isHookPayload(payload)) {
    process.stderr.write(
      "Error: stdin JSON missing required fields (session_id, cwd, hook_event_name)\n",
    );
    exit(1);
  }

  const { session_id, cwd, hook_event_name } = payload;

  if (!cwd) {
    process.stderr.write("Error: cwd is empty; cannot resolve project dir\n");
    exit(1);
  }

  const projectDir = await resolveProjectDir(cwd, claudeDir);

  if (hook_event_name === "Notification") {
    try {
      await writeNotificationStatus(
        projectDir,
        payload.message ?? "",
        payload.notification_type ?? "",
        payload.session_id,
        payload.cwd,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error writing notification status: ${message}\n`);
      exit(1);
    }
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // Per-sub-agent status files use .json (single object) rather than
  // .jsonl (NDJSON). This is intentional: sub-agent status tracks a single
  // "stopped" state, not an event sequence like the main session log.

  if (hook_event_name === "SubagentStop") {
    const agentTranscriptPath = payload.agent_transcript_path;
    if (agentTranscriptPath) {
      // Derive per-sub-agent status file alongside the JSONL transcript.
      const agentStatusPath = agentTranscriptPath.endsWith(".jsonl")
        ? `${agentTranscriptPath.slice(0, -".jsonl".length)}.ccmon-status.json`
        : `${agentTranscriptPath}.ccmon-status.json`;
      try {
        await writeSubagentStatus(agentStatusPath, projectDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error writing subagent status: ${message}\n`);
        exit(1);
      }
    }
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const state = mapHookEventToState(hook_event_name);
  if (state === null) {
    // Unknown hook event — respond OK so Claude doesn't block on unrecognized events
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const event: StatusEvent = {
    event: hook_event_name,
    state,
    timestamp: new Date().toISOString(),
    session_id,
    working_dir: cwd,
  };

  try {
    if (hook_event_name === "SessionEnd") {
      await writeStatusTruncate(projectDir, event);
    } else {
      await writeStatusEvent(projectDir, event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error writing status: ${message}\n`);
    exit(1);
  }

  // Hook protocol requires a JSON response on stdout
  process.stdout.write("{}\n");
  process.exit(0);
}

/**
 * Resolves the project directory for a given cwd.
 * 1. Fast path: scans known project dirs for an exact cwd match.
 * 2. Subdirectory match: if cwd is a subdirectory of a known project's cwd,
 *    use that project dir (longest match wins if multiple).
 * 3. Fallback: encodes the cwd as a dir name (/ → -), creating it if needed.
 */
async function resolveProjectDir(cwd: string, dir: string): Promise<string> {
  const projects = await scanProjects(dir);
  const match = projects.find((p) => p.cwd === cwd);
  if (match) {
    return join(dir, match.projectDir);
  }

  // Subdirectory match: find projects where cwd is under their cwd
  let bestMatch: (typeof projects)[number] | null = null;
  for (const project of projects) {
    if (cwd.startsWith(`${project.cwd}/`)) {
      if (!bestMatch || project.cwd.length > bestMatch.cwd.length) {
        bestMatch = project;
      }
    }
  }
  if (bestMatch) {
    return join(dir, bestMatch.projectDir);
  }

  // Fallback: encode cwd the same way Claude Code does (replacing / with -)
  const encoded = cwd.replace(/\//g, "-");
  const fallbackDir = join(dir, encoded);
  await mkdir(fallbackDir, { recursive: true });
  return fallbackDir;
}

async function runSub(): Promise<void> {
  const port =
    parseNumberFlag(process.argv, "--port") ??
    (process.argv.includes("--port") ? NaN : config.port);
  if (process.argv.includes("--port") && Number.isNaN(port)) {
    process.stderr.write("Error: --port requires a valid number\n");
    exit(1);
  }

  const host = parseStringFlag(process.argv, "--host") ?? "localhost";
  if (process.argv.includes("--host") && host === null) {
    process.stderr.write("Error: --host requires a value\n");
    exit(1);
  }

  const ws = new WebSocket(`ws://${host}:${port}/ws`);

  ws.onmessage = (event) => {
    const parsed = JSON.parse(event.data.toString());
    const projects = Array.isArray(parsed) ? parsed : parsed.projects;
    process.stdout.write(`${JSON.stringify(projects)}\n`);
  };

  ws.onerror = () => {
    process.stderr.write("ccmon sub: connection error\n");
    process.exit(1);
  };

  ws.onclose = () => {
    process.exit(0);
  };

  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}

async function readStdin(): Promise<string> {
  return readFileSync(process.stdin.fd, "utf-8");
}

interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  message?: string;
  notification_type?: string;
  agent_id?: string;
  agent_transcript_path?: string;
}

function isHookPayload(v: unknown): v is HookPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.session_id === "string" &&
    typeof obj.cwd === "string" &&
    typeof obj.hook_event_name === "string"
  );
}
