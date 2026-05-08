# Claude Code & OpenCode Monitor (ccmon)

> [!WARNING]
> This project is vibe-coded. Don't expect anything stable.

Real-time dashboard for your Claude Code & OpenCode sessions.

<img width="891" height="483" alt="Screenshot 2026-02-22 at 14 29 37" src="https://github.com/user-attachments/assets/100be8f2-ba2a-4686-8b63-75b1b4b23f42" />

## Quick Start

1. [Installation](#installation) or run locally with `npm run serve`
2. [Hook Configuration](#hook-configuration) (for Claude Code)
3. Start server with `ccmon serve`
4. Open [http://localhost:8080](http://localhost:8080) in your browser

## Features

- View all your active Claude Code or OpenCode sessions, including their status, context usage, task
  progress, and sub-agents
  - Status reporting is semi-real-time for Claude Code, via hooks, but polled every 5s for OpenCode
- Visual notifications when user attention is required (permission requests, stopped sessions, etc.)

## Commands

```
ccmon serve [--port N]  # HTTP + WebSocket server (default port 8080)
ccmon status            # Hook handler: reads event from stdin, writes status file
ccmon dump              # Print all project states as JSON
ccmon dump --watch      # Stream project states on change
```

`dump` and `dump --watch` are primarily for debugging/scripting.

## Installation

### Via flakes

```nix
# Add flake input:
inputs.ccmon.url = "github:appaquet/ccmon";

# Add to packages:
inputs.ccmon.packages.${system}.default
```

### OpenCode Plugin (optional)

For near-instant OpenCode status detection, install the plugin:

```bash
# Manual install — copy file to plugins directory
cp resources/opencode-plugin/ccmon.ts ~/.config/opencode/plugins/ccmon.ts

# Via Nix packages (home-manager example):
home.file.".config/opencode/plugins/ccmon.ts".source = "${pkgs.ccmon.opencode-plugin}/ccmon.ts";
```

Without the plugin, OpenCode sessions are detected via SQLite polling (5s interval, `running`/`stopped` only).

### Hook Configuration

Configure Claude Code hooks in `~/.claude/settings.json` (or project-level `.claude/settings.json`).
The project use them to track real-time signals that aren't available through watching session
files.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ccmon status" }
        ]
      }
    ]
  }
}
```

## Development

```
npm install     # Install dependencies
npm test        # Run tests
npm run dump    # Dump project states
npm run serve   # Start server
```
