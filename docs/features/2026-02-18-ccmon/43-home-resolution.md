# Phase 43: Fix Home Directory Resolution

## Context

See [00-ccmon](00-ccmon.md). Bun 1.3.11 from the Nix flake does not expose `process.env` (or `Bun.env`) to JS — `Object.getOwnPropertyNames(process.env)` returns only 3 bun-injected entries (`TZ`, `NODE_TLS_REJECT_UNAUTHORIZED`, `BUN_CONFIG_VERBOSE_FETCH`). `Bun.env.HOME` is `undefined`, so the `?? "/root"` fallback kicks in, resolving default paths to `/root/.claude/projects` and `/root/.config`.

`os.homedir()` (from `node:os`) works correctly — it reads `/etc/passwd` when `$HOME` is missing from the environment. This is the correct approach and removes the misleading `/root` literal.

## Questions & Investigations

- [x] Q: Can `os.homedir()` be used as fallback in bun?
  - Verified: `bun -e "import { homedir } from 'node:os'; console.log(homedir());"` → `/home/appaquet` ✓
- [x] Q: Why can't lint/typecheck commands run?
  - `bun run lint` and `bun run typecheck` fail with `CouldntReadCurrentDirectory` — same underlying Bun/env issue
  - 199 of 225 tests pass; 26 CLI test failures are `bun not found in $PATH` from `Bun.spawn()` — pre-existing
- [x] Q: Why does `Bun.spawn(["bun", ...])` fail with "Executable not found in $PATH"?
  - Bun in sandbox has `process.env` effectively empty ([github.com/oven-sh/bun/issues/27802](https://github.com/oven-sh/bun/issues/27802))
  - `process.env.PATH` is `undefined` so `Bun.spawn` can't find `bun` by name
  - `process.env` properties are non-enumerable — `{...process.env}` and `Object.keys()` return empty
  - `Object.getOwnPropertyNames(process.env)` returns only 3 Bun-injected keys: `TZ`, `NODE_TLS_REJECT_UNAUTHORIZED`, `BUN_CONFIG_VERBOSE_FETCH`
  - `os.homedir()` works (reads `/etc/passwd`), confirming the system knows user identity
- [x] Q: How to fix Bun.spawn for CLI tests?
  - Replace `"bun"` with `process.execPath` (full Nix store path) — works without needing PATH
  - Bun.spawn `env` option correctly sets OS-level environment (verified via `/proc/self/environ` in child)
  - But Bun's `process.env` initialization still fails in child — add `/proc/self/environ` restoration at CLI entry point
  - Result: 225/225 tests passing, 0 failures
- [x] Q: Is `/proc/self/environ` restoration reliable?
  - Linux-specific (`/proc/self/environ` doesn't exist on macOS)
  - Wrapped in try/catch — silent fallback on unsupported platforms
  - Used by pi-mono project's Bun sandbox workaround ([github.com/badlogic/pi-mono/issues/3573](https://github.com/badlogic/pi-mono/issues/3573))
  - Should be re-evaluated when [Bun #27802](https://github.com/oven-sh/bun/issues/27802) is fixed upstream

## Tasks

- [x] Replace `Bun.env.HOME ?? "/root"` with `homedir()` in `src/sessions.ts:44` (`DEFAULT_CLAUDE_DIR`)
  - AC: `DEFAULT_CLAUDE_DIR` resolves to the user's actual home directory (not `/root`)
- [x] Replace `Bun.env.HOME ?? "/root"` with `homedir()` in `src/cli.ts:24` (fallback `claudeDir`)
  - AC: Default `claudeDir` resolves to the user's actual home directory (not `/root`)
- [x] Replace `process.env.HOME ?? "/root"` with `homedir()` in `src/config.ts:68` (XDG config base fallback)
  - AC: Default config path resolves to `~/.config/ccmon/config.json` (not `/root/.config/...`)
- [x] Fix CLI tests — `Bun.spawn(["bun", ...])` fails because `process.env.PATH` is empty in sandbox
  - AC: All CLI tests pass (use `process.execPath` instead of `"bun"`; add `/proc/self/environ` restoration for spawned processes)
- [x] Run lint, typecheck, and full test suite — all 225 tests pass
  - AC: `bun run lint`, `bun run typecheck`, `bun test` all clean

## Files

- **src/config.ts**: Replace `process.env.HOME` fallback with `homedir()`; add `node:os` import
- **src/sessions.ts**: Replace `Bun.env.HOME` fallback with `homedir()`; add `node:os` import
- **src/cli.ts**: Replace `Bun.env.HOME` fallback with `homedir()`; call `restoreProcessEnv()` at startup
- **src/env.ts**: New — `restoreProcessEnv()` utility: Linux-only `/proc/self/environ` fallback when `process.env` is denuded (Bun #27802 workaround)
- **tests/cli.test.ts**: Replace `"bun"` with `process.execPath` in `spawnCli()` for sandbox PATH
- **docs/features/2026-02-18-ccmon/43-home-resolution.md**: This file
