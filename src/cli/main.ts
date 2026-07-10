#!/usr/bin/env node
import packageJson from "../../package.json" with { type: "json" };
import { loadConfig, mergeCliOverrides } from "../config.ts";
import { runDump, runDumpWatch } from "./commands/dump.ts";
import { runServe } from "./commands/serve.ts";
import { runStatus } from "./commands/status.ts";
import { runSub } from "./commands/sub.ts";
import { parseNumberFlag, parsePortFlag, parseStringFlag } from "./helpers.ts";

const VERSION = packageJson.version;

const subcommand = process.argv[2];

if (subcommand === "--version" || subcommand === "-v") {
  process.stdout.write(`ccmon ${VERSION}\n`);
  process.exit(0);
}

const config = loadConfig();

const commands: Record<string, () => Promise<number | undefined>> = {
  dump: async () => {
    const projectFilter = requireStringFlag("--project");
    const maxAgeArg = requireNumberFlag("--max-age");
    const commandConfig = mergeCliOverrides(config, {
      maxInactivityHours: process.argv.includes("--no-filter")
        ? Infinity
        : maxAgeArg,
    });
    if (process.argv.includes("--watch")) {
      await runDumpWatch(commandConfig, projectFilter);
      return;
    }
    return runDump(commandConfig, projectFilter);
  },
  status: () => runStatus(),
  sub: async () => {
    let subPort: number;
    if (process.argv.includes("--port")) {
      const parsed = parsePortFlag(process.argv, "--port");
      if (parsed === undefined) {
        process.stderr.write("Error: --port requires a valid number\n");
        return 1;
      }
      subPort = parsed;
    } else {
      subPort = config.port;
    }

    const parsedHost = parseStringFlag(process.argv, "--host");
    if (process.argv.includes("--host") && parsedHost === null) {
      process.stderr.write("Error: --host requires a value\n");
      return 1;
    }
    runSub(subPort, parsedHost ?? "localhost");
  },
  serve: async () => {
    const port = parsePortFlag(process.argv, "--port");
    if (process.argv.includes("--port") && port === undefined) {
      process.stderr.write("Error: --port requires a valid number\n");
      return 1;
    }

    const host = parseStringFlag(process.argv, "--host");
    if (process.argv.includes("--host") && host === null) {
      process.stderr.write("Error: --host requires a value\n");
      return 1;
    }

    await runServe(config, port, host);
  },
};

const command = subcommand ? commands[subcommand] : undefined;
if (command) {
  const code = await command();
  if (code !== undefined) process.exit(code);
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
  serve --host <addr>    Listen on custom host (default: 127.0.0.1)
  serve --port <N>       Listen on custom port (default: 8080)
  sub                    Connect to running server, stream state as NDJSON
  sub --host <addr>      Connect to custom host (default: localhost)
  sub --port <N>         Connect to custom port (default: 8080)

Supports Claude Code and OpenCode monitoring. Configure backends in
~/.config/ccmon/config.json (default: both Claude Code and OpenCode).
`,
  );
  process.exit(1);
}

function requireStringFlag(name: string): string | null {
  const value = parseStringFlag(process.argv, name);
  if (process.argv.includes(name) && value === null) {
    process.stderr.write(`Error: ${name} requires a value\n`);
    process.exit(1);
  }
  return value;
}

function requireNumberFlag(name: string): number | undefined {
  const value = parseNumberFlag(process.argv, name);
  if (process.argv.includes(name) && value === undefined) {
    process.stderr.write(`Error: ${name} requires a valid number\n`);
    process.exit(1);
  }
  return value;
}
