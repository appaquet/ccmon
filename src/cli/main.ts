#!/usr/bin/env node
import { loadConfig, mergeCliOverrides } from "../config";
import { runDump, runDumpWatch } from "./commands/dump";
import { runServe } from "./commands/serve";
import { runStatus } from "./commands/status";
import { runSub } from "./commands/sub";
import { parseNumberFlag, parseStringFlag } from "./helpers";

const VERSION = "0.1.0";

const subcommand = process.argv[2];

if (subcommand === "--version" || subcommand === "-v") {
  process.stdout.write(`ccmon ${VERSION}\n`);
  process.exit(0);
}

const projectFilter = parseStringFlag(process.argv, "--project");
if (process.argv.includes("--project") && projectFilter === null) {
  process.stderr.write("Error: --project requires a value\n");
  process.exit(1);
}

const maxAgeArg = parseNumberFlag(process.argv, "--max-age");
if (process.argv.includes("--max-age") && maxAgeArg === undefined) {
  process.stderr.write("Error: --max-age requires a valid number\n");
  process.exit(1);
}

const noFilter = process.argv.includes("--no-filter");

const config = mergeCliOverrides(loadConfig(), {
  maxInactivityHours: noFilter ? Infinity : maxAgeArg,
});

if (subcommand === "dump") {
  const watch = process.argv.includes("--watch");

  if (watch) {
    await runDumpWatch(config, projectFilter);
  } else {
    await runDump(config, projectFilter);
  }
} else if (subcommand === "status") {
  await runStatus();
} else if (subcommand === "sub") {
  let subPort: number;
  if (process.argv.includes("--port")) {
    const parsed = parseNumberFlag(process.argv, "--port");
    if (parsed === undefined) {
      process.stderr.write("Error: --port requires a valid number\n");
      process.exit(1);
    }
    subPort = parsed;
  } else {
    subPort = config.port;
  }

  const subHost = parseStringFlag(process.argv, "--host") ?? "localhost";
  if (process.argv.includes("--host") && subHost === null) {
    process.stderr.write("Error: --host requires a value\n");
    process.exit(1);
  }

  runSub(subPort, subHost);
} else if (subcommand === "serve") {
  const port = parseNumberFlag(process.argv, "--port");
  if (process.argv.includes("--port") && port === undefined) {
    process.stderr.write("Error: --port requires a valid number\n");
    process.exit(1);
  }

  const host = parseStringFlag(process.argv, "--host");
  if (process.argv.includes("--host") && host === null) {
    process.stderr.write("Error: --host requires a value\n");
    process.exit(1);
  }

  runServe(config, port, host);
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
