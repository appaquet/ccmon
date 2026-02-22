# Claude Code Monitor (ccmon)

> [!WARNING]
> This project is vibe-coded. Don't expect anything stable.

Real-time dashboard for your Claude Code sessions.

<img width="891" height="483" alt="Screenshot 2026-02-22 at 14 29 37" src="https://github.com/user-attachments/assets/100be8f2-ba2a-4686-8b63-75b1b4b23f42" />

## Quick Start

1. Install — see [Installation](#instalation) or run locally with `bun run serve`
2. Configure hooks — see [Hook Configuration](#hook-configuration)
3. Start server with `ccmon serve`
4. Open [http://localhost:8080](http://localhost:8080) in your browser

## Features

- View all your active Claude Code sessions, including their status, context usage, task progress,
  and sub-agents
- Visual notifications for Claude Code when user attention is required (permission requests, stopped
  sessions, etc.)

## Commands

```
ccmon serve [--port N]  # HTTP + WebSocket server (default port 3000)
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

Hook events tracked: `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`, `Notification`, `SessionStart`.

## Development

```
bun install     # Install dependencies
bun test        # Run tests
bun run dump    # Dump project states
bun run serve   # Start server
```
