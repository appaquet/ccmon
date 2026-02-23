# Phase: Linting Setup

## Context

See [00-ccmon](00-ccmon.md). Add Biome linting and TypeScript type-check. Wire `test`/`lint`/`lint:fix`/`typecheck` scripts in package.json. Document in CLAUDE.md.

## Tasks

- [x] Install Biome: `bun add --dev --exact @biomejs/biome`
- [x] Init Biome config: `bunx biome init` → generated `biome.json`
- [x] Configure `biome.json`: set `indentStyle: "space"`, `indentWidth: 2`; recommended linter rules
- [x] Add scripts to `package.json`:
  - `"test": "bun test"`
  - `"lint": "bunx biome check src/ tests/"`
  - `"lint:fix": "bunx biome check --write src/ tests/"`
  - `"typecheck": "tsc --noEmit"`
- [x] Install TypeScript devDep for typecheck: `bun add --dev typescript`
- [x] Update `CLAUDE.md`: added `### lint` and `### typecheck` sections after `### test`
- [x] Run `bun run lint:fix` — auto-fixed formatting (tabs→spaces), `isNaN`→`Number.isNaN`, template literals, unused params
- [x] Fix remaining manual violations: non-null assertions in sessions.test.ts, type annotations in sessions.ts, server.port
- [x] Run `bun run typecheck` — 9 type errors found and fixed (readdir types, optional chaining, server.port)
- [x] Run `bun test` — 198 tests pass

## Files

- **package.json**: Added `test`, `lint`, `lint:fix`, `typecheck` scripts; `@biomejs/biome` and `typescript` devDependencies
- **biome.json**: New file — Biome config with space indentation (indentWidth 2), recommended linter rules
- **bun.lock**: Updated lockfile
- **CLAUDE.md**: Added `### lint` and `### typecheck` command sections
- **src/cli.ts**: `isNaN`→`Number.isNaN` (3×), template literals
- **src/server.ts**: `server.port!` non-null assertion for Bun type
- **src/sessions.ts**: `import type { Dirent }`, explicit `Dirent<string>[]` type, `cached!.data` assertion
- **src/watcher.ts**: Unused param renamed to `_eventType`
- **tests/cli.test.ts**: Template literals (8×)
- **tests/server.test.ts**: Template literals (6×)
- **tests/sessions.test.ts**: Non-null assertions replaced with `as string` casts, optional chaining fix
