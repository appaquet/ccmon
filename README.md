# ccmon

Claude Code Monitor — monitors Claude Code sessions across projects. Provides real-time visibility into session state via CLI or web dashboard. Integrates seamlessly via Claude Code hooks.

> [!WARNING]
> This project is vibe-coded — built collaboratively with Claude Code. Expect rough edges.

## Quick Start

1. Install — see [Installation](#installation-nix-flake) or run locally with `bun run serve`
2. Configure hooks — see [Hook Configuration](#hook-configuration)
3. Open [http://localhost:3000](http://localhost:3000) in your browser

## Commands

```
ccmon serve [--port N]  # HTTP + WebSocket server (default port 3000)
ccmon status            # Hook handler: reads event from stdin, writes status file
ccmon dump              # Print all project states as JSON
ccmon dump --watch      # Stream project states on change
```

`dump` and `dump --watch` are primarily for debugging/scripting.

## Installation (Nix Flake)

Add to your `flake.nix`:

```nix
inputs.ccmon.url = "github:appaquet/ccmon";

# In home-manager or systemPackages:
inputs.ccmon.packages.${system}.default
```

## Hook Configuration

Configure Claude Code hooks in `~/.claude/settings.json` (or project-level `.claude/settings.json`):

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
