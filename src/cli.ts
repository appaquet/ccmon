import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectState, scanProjects, mapHookEventToState, writeStatus } from './sessions';
import { watchForChanges } from './watcher';
import { startServer } from './server';

const claudeDir = Bun.env.CLAUDE_PROJECTS_DIR ?? join(Bun.env.HOME ?? '/root', '.claude', 'projects');

const subcommand = process.argv[2];

const projectFlagIdx = process.argv.indexOf('--project');
const projectFilter = projectFlagIdx !== -1 ? (process.argv[projectFlagIdx + 1] ?? null) : null;

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

  const { port: resolvedPort, stop } = startServer({ port });
  process.stdout.write(`ccmon server listening on http://localhost:${resolvedPort}\n`);

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
    'Usage: ccmon <subcommand>\n\nSubcommands:\n  dump           Print current Claude Code project state as JSON\n  dump --watch   Watch for changes and print updates\n  status         Read hook event from stdin and write status file\n  serve          Start HTTP + WebSocket server\n  sub            Connect to running server, stream state as NDJSON\n',
  );
  process.exit(1);
}

async function runDump(): Promise<void> {
  try {
    const state = await getProjectState(claudeDir);
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
  function formatWatchOutput(state: Awaited<ReturnType<typeof getProjectState>>): string {
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

  const watcher = watchForChanges(claudeDir, async () => {
    try {
      const state = await getProjectState(claudeDir);
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

  const state = mapHookEventToState(hook_event_name);
  if (state === null) {
    // Unknown hook event — respond OK so Claude doesn't block on unrecognized events
    process.stdout.write('{}\n');
    process.exit(0);
    return;
  }

  const projectDir = await resolveProjectDir(cwd, claudeDir);

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
  const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 3000;

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
