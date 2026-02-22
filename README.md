# ccmon

Claude Code Monitor — monitors Claude Code sessions across projects. Provides real-time visibility into session state via CLI or web dashboard. Integrates seamlessly via Claude Code hooks.

## Commands

```
ccmon dump              # Print all project states as JSON
ccmon dump --watch      # Watch and print on changes
ccmon status            # Hook handler: reads event from stdin, writes status file
ccmon serve [--port N]  # HTTP + WebSocket server (default port 3000)
```

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

Hook events tracked: `PermissionRequest`, `Stop`, `SessionEnd`, `Notification`, `SessionStart`.

## Development

```
bun install     # Install dependencies
bun test        # Run tests
bun run dump    # Dump project states
bun run serve   # Start server
```
