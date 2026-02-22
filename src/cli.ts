import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectState, scanProjects, mapHookEventToState, writeStatus, writeNotificationStatus, filterStaleProjects } from './sessions';
import { loadConfig, mergeCliOverrides } from './config';
import { watchForChanges } from './watcher';
import { startServer } from './server';

const claudeDir = Bun.env.CLAUDE_PROJECTS_DIR ?? join(Bun.env.HOME ?? '/root', '.claude', 'projects');

const subcommand = process.argv[2];

// REVIEW: architecture-reviewer - CLI argument parsing is scattered across module-level statements using repeated `indexOf`/`includes` calls. All flags are parsed unconditionally for every subcommand (e.g., `--project` is parsed even for `status` which ignores it). There is no centralized argument validation or subcommand-scoped parsing. Consider moving flag resolution inside each handler function or a dedicated parse function, which would make it easier to validate required-per-subcommand flags and avoid accumulating global state at module scope.
const projectFlagIdx = process.argv.indexOf('--project');
// REVIEW: code-correctness-reviewer - If `--project` is the last argument, `process.argv[projectFlagIdx + 1]` is `undefined`, `projectFilter` becomes `null`, and the flag is silently ignored — showing all projects instead of erroring. The user typed `--project` expecting a filter but gets unfiltered output. Add a check: `if (projectFlagIdx !== -1 && !projectFilter) { process.stderr.write('Error: --project requires a value\n'); process.exit(1); }`.
const projectFilter = projectFlagIdx !== -1 ? (process.argv[projectFlagIdx + 1] ?? null) : null;

const maxAgeIdx = process.argv.indexOf('--max-age');
// REVIEW: code-correctness-reviewer - If `--max-age` is the last argument or is followed by another flag, `process.argv[maxAgeIdx + 1]` is undefined or a flag string, and `parseFloat` returns NaN. NaN is passed silently to `mergeCliOverrides` and then to `filterStaleProjects` where `!isFinite(NaN)` disables filtering with no error feedback to the user. Consider validating: `if (isNaN(maxAgeArg)) { process.stderr.write('Error: --max-age requires a valid number\n'); process.exit(1); }`.
const maxAgeArg = maxAgeIdx !== -1 ? parseFloat(process.argv[maxAgeIdx + 1] ?? '') : undefined;
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
    process.exit(1);
  }

  const hostArg = process.argv.indexOf('--host');
  // REVIEW: code-correctness-reviewer - If `--host` is the last argument or followed by another flag, `process.argv[hostArg + 1]` is undefined (or a flag string like `--port`), silently falling back to the config default host with no error feedback. Consistent with the `--port` validation above, add a check: `if (hostArg !== -1 && !host) { process.stderr.write('Error: --host requires a value\n'); process.exit(1); }`.
  const host = hostArg !== -1 ? process.argv[hostArg + 1] : undefined;

  const serveConfig = mergeCliOverrides(config, { port, host });
  const { port: resolvedPort, stop } = startServer({ port: serveConfig.port, hostname: serveConfig.host, maxInactivityHours: serveConfig.maxInactivityHours });
  process.stdout.write(`ccmon server listening on http://${serveConfig.host}:${resolvedPort}\n`);

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
    // REVIEW: code-style-reviewer - The `return` after `process.exit(1)` is unreachable dead code. TypeScript/Bun don't infer `process.exit` as `never`, so the `return` is added to satisfy the type-checker — but this pattern repeats 7 times in `runStatus` alone. A cleaner approach is to extract a typed `exit(code: number): never` helper that wraps `process.exit`, eliminating all the dead `return` statements. Applies to all `process.exit(1); return;` pairs in this file.
    process.exit(1);
    return;
  }

  if (!raw.trim()) {
    process.stderr.write('Error: empty stdin — expected hook JSON payload\n');
    process.exit(1);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('Error: invalid JSON on stdin — expected hook JSON payload\n');
    process.exit(1);
    return;
  }

  if (!isHookPayload(payload)) {
    process.stderr.write(
      'Error: stdin JSON missing required fields (session_id, cwd, hook_event_name)\n',
    );
    process.exit(1);
    return;
  }

  const { session_id, cwd, hook_event_name } = payload;

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
      process.exit(1);
      return;
    }
    process.stdout.write('{}\n');
    process.exit(0);
    return;
  }

  const state = mapHookEventToState(hook_event_name);
  if (state === null) {
    // Unknown hook event — respond OK so Claude doesn't block on unrecognized events
    process.stdout.write('{}\n');
    process.exit(0);
    return;
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
    process.exit(1);
    return;
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
// REVIEW: architecture-reviewer - `resolveProjectDir` performs a full `scanProjects` directory sweep (reads every project subdir) on every hook event invocation just to find the matching project directory. Hook events can fire frequently (every tool use, every prompt). This is O(n) I/O per hook call where n is the number of projects. Since the `status` subcommand is a short-lived process, this is not catastrophic, but it means every PostToolUse event enumerates all project dirs. The simpler and cheaper approach is to derive the project dir directly from the cwd encoding (replace `/` with `-`) and only fall back to a scan when direct lookup misses — which is what the fallback does anyway. The scan could be removed entirely in favor of always using the encoding, consistent with how Claude Code itself creates these directories.
async function resolveProjectDir(cwd: string, dir: string): Promise<string> {
  const projects = await scanProjects(dir);
  const match = projects.find((p) => p.cwd === cwd);
  if (match) {
    return join(dir, match.projectDir);
  }

  // Fallback: encode cwd the same way Claude Code does (replacing / with -)
  const encoded = cwd.replace(/\//g, '-');
  // REVIEW: code-correctness-reviewer - If `cwd` is an empty string, `encoded` is also empty, and `join(dir, '')` resolves to `dir` itself (the Claude projects root). `mkdir(dir, { recursive: true })` would then create the root dir (likely already exists), and `writeStatus` would write `status.local.json` into the root Claude projects dir — polluting it. The `cwd` field comes from hook JSON and `isHookPayload` only checks that it is a string, not that it is non-empty. Add a guard: `if (!encoded) { throw new Error('cwd is empty; cannot resolve project dir'); }`.
  const fallbackDir = join(dir, encoded);
  await mkdir(fallbackDir, { recursive: true });
  return fallbackDir;
}

async function runSub(): Promise<void> {
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : config.port;

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

// REVIEW: code-style-reviewer - Manual chunk accumulation and Uint8Array concatenation is more verbose than necessary. Bun provides `Bun.readableStreamToText(Bun.stdin.stream())` which handles this in one line. Alternatively, `new Response(Bun.stdin.stream()).text()` achieves the same result idiomatically. The current implementation is functionally correct but harder to read than the Bun-idiomatic approach.
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
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
