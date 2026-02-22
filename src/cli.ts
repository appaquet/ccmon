import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectState, scanProjects, mapHookEventToState, writeStatus, writeNotificationStatus, filterStaleProjects } from './sessions';
import { loadConfig, mergeCliOverrides } from './config';
import { watchForChanges } from './watcher';
import { startServer } from './server';

function exit(code: number): never {
  process.exit(code);
}

const claudeDir = Bun.env.CLAUDE_PROJECTS_DIR ?? join(Bun.env.HOME ?? '/root', '.claude', 'projects');

// REVIEW: architecture-reviewer - CLI argument parsing is done inline at module top-level using manual process.argv.indexOf calls scattered across the file. This means all flags (--project, --max-age, --no-filter, --port, --host) are parsed globally before the subcommand branch is reached, so flags intended only for specific subcommands are evaluated for every invocation. As the CLI grows, this approach makes it difficult to add subcommand-specific flags, validate flag combinations, or generate accurate help text. Consider a structured argument parsing approach (even a minimal one) that groups flags by subcommand and validates them after the subcommand is known.
const subcommand = process.argv[2];

const projectFlagIdx = process.argv.indexOf('--project');
const projectFilter = projectFlagIdx !== -1 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
if (projectFlagIdx !== -1 && !projectFilter) {
  process.stderr.write('Error: --project requires a value\n');
  exit(1);
}

const maxAgeIdx = process.argv.indexOf('--max-age');
const maxAgeArg = maxAgeIdx !== -1 ? parseFloat(process.argv[maxAgeIdx + 1] ?? '') : undefined;
if (maxAgeIdx !== -1 && (maxAgeArg === undefined || isNaN(maxAgeArg))) {
  process.stderr.write('Error: --max-age requires a valid number\n');
  exit(1);
}
const noFilter = process.argv.includes('--no-filter');

const config = mergeCliOverrides(
  loadConfig(),
  {
    maxInactivityHours: noFilter ? Infinity : maxAgeArg,
  },
);

if (subcommand === 'dump') {
  const watch = process.argv.includes('--watch');

  if (watch) {
    await runDumpWatch();
  } else {
    await runDump();
  }
} else if (subcommand === 'status') {
  await runStatus();
} else if (subcommand === 'sub') {
  await runSub();
} else if (subcommand === 'serve') {
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : undefined;

  if (port !== undefined && isNaN(port)) {
    process.stderr.write('Error: --port requires a valid number\n');
    exit(1);
  }

  const hostArg = process.argv.indexOf('--host');
  const host = hostArg !== -1 ? process.argv[hostArg + 1] : undefined;
  if (hostArg !== -1 && !host) {
    process.stderr.write('Error: --host requires a value\n');
    exit(1);
  }

  const serveConfig = mergeCliOverrides(config, { port, host });
  const { port: resolvedPort, stop } = startServer({
    port: serveConfig.port,
    hostname: serveConfig.host,
    maxInactivityHours: serveConfig.maxInactivityHours,
  });
  const displayHost = serveConfig.host === '0.0.0.0' ? 'localhost' : serveConfig.host;
  process.stdout.write(`ccmon server listening on http://${displayHost}:${resolvedPort}\n`);

  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
} else {
  process.stderr.write(
    'Usage: ccmon <subcommand>\n\nSubcommands:\n  dump                   Print current Claude Code project state as JSON\n  dump --watch           Watch for changes and print updates\n  dump --max-age <hours> Override maxInactivityHours from config\n  dump --no-filter       Disable inactivity filter\n  status                 Read hook event from stdin and write status file\n  serve                  Start HTTP + WebSocket server\n  serve --host <addr>    Listen on custom host (default: 0.0.0.0)\n  serve --port <N>       Listen on custom port (default: 9480)\n  sub                    Connect to running server, stream state as NDJSON\n',
  );
  process.exit(1);
}

async function runDump(): Promise<void> {
  try {
    const rawState = await getProjectState(claudeDir);
    const state = filterStaleProjects(rawState, config.maxInactivityHours);
    if (projectFilter !== null) {
      const match = state.find((p) => p.projectName === projectFilter) ?? null;
      if (match !== null) {
        console.log(JSON.stringify(match, null, 2));
      }
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

async function runDumpWatch(): Promise<void> {
  function formatWatchOutput(rawState: Awaited<ReturnType<typeof getProjectState>>): string {
    const state = filterStaleProjects(rawState, config.maxInactivityHours);
    if (projectFilter !== null) {
      const match = state.find((p) => p.projectName === projectFilter) ?? null;
      return match !== null ? JSON.stringify(match, null, 2) : '';
    }
    return JSON.stringify(state, null, 2);
  }

  try {
    const state = await getProjectState(claudeDir);
    const output = formatWatchOutput(state);
    if (output) console.log(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error getting initial state: ${message}\n`);
    process.exit(1);
  }

  const watcher = watchForChanges(claudeDir, async (projectDir: string) => {
    try {
      const state = await getProjectState(claudeDir, projectDir);
      const output = formatWatchOutput(state);
      if (output) console.log(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error getting state update: ${message}\n`);
    }
  });

  process.on('SIGINT', () => {
    watcher.stop();
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
    process.stderr.write('Error: empty stdin — expected hook JSON payload\n');
    exit(1);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('Error: invalid JSON on stdin — expected hook JSON payload\n');
    exit(1);
  }

  if (!isHookPayload(payload)) {
    process.stderr.write(
      'Error: stdin JSON missing required fields (session_id, cwd, hook_event_name)\n',
    );
    exit(1);
  }

  const { session_id, cwd, hook_event_name } = payload;

  if (!cwd) {
    process.stderr.write('Error: cwd is empty; cannot resolve project dir\n');
    exit(1);
  }

  const projectDir = await resolveProjectDir(cwd, claudeDir);

  if (hook_event_name === 'Notification') {
    try {
      await writeNotificationStatus(
        projectDir,
        payload.message ?? '',
        payload.notification_type ?? '',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error writing notification status: ${message}\n`);
      exit(1);
    }
    process.stdout.write('{}\n');
    process.exit(0);
  }

  const state = mapHookEventToState(hook_event_name);
  if (state === null) {
    // Unknown hook event — respond OK so Claude doesn't block on unrecognized events
    process.stdout.write('{}\n');
    process.exit(0);
  }

  try {
    await writeStatus(projectDir, {
      state,
      timestamp: new Date().toISOString(),
      session_id,
      working_dir: cwd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error writing status: ${message}\n`);
    exit(1);
  }

  // Hook protocol requires a JSON response on stdout
  process.stdout.write('{}\n');
  process.exit(0);
}

/**
 * Resolves the project directory for a given cwd.
 * Scans known project dirs for an exact cwd match first.
 * Falls back to encoding the cwd as a dir name (/ → -) when no match is found,
 * creating the directory if needed.
 */
async function resolveProjectDir(cwd: string, dir: string): Promise<string> {
  const projects = await scanProjects(dir);
  const match = projects.find((p) => p.cwd === cwd);
  if (match) {
    return join(dir, match.projectDir);
  }

  // Fallback: encode cwd the same way Claude Code does (replacing / with -)
  const encoded = cwd.replace(/\//g, '-');
  const fallbackDir = join(dir, encoded);
  await mkdir(fallbackDir, { recursive: true });
  return fallbackDir;
}

async function runSub(): Promise<void> {
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? parseInt(process.argv[portArg + 1] ?? '', 10) : config.port;
  if (portArg !== -1 && isNaN(port)) {
    process.stderr.write('Error: --port requires a valid number\n');
    exit(1);
  }

  const ws = new WebSocket(`ws://localhost:${port}/ws`);

  ws.onmessage = (event) => {
    process.stdout.write(event.data + '\n');
  };

  ws.onerror = () => {
    process.stderr.write('ccmon sub: connection error\n');
    process.exit(1);
  };

  ws.onclose = () => {
    process.exit(0);
  };

  process.on('SIGINT', () => {
    ws.close();
    process.exit(0);
  });
}

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  message?: string;
  notification_type?: string;
}

function isHookPayload(v: unknown): v is HookPayload {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.session_id === 'string' &&
    typeof obj.cwd === 'string' &&
    typeof obj.hook_event_name === 'string'
  );
}
