# Phase: Linting Setup

## Context

See [00-ccmon](00-ccmon.md). Add Biome linting, wire `test`/`lint`/`lint:fix`/`typecheck` scripts in `package.json`, and document commands in `CLAUDE.md`.

## Tasks

- [ ] Install Biome: `bun add --dev --exact @biomejs/biome`
- [ ] Init Biome config: `bunx biome init` → generates `biome.json`
- [ ] Configure `biome.json`: set `indentStyle: "space"`, `indentWidth: 2`; enable recommended linter rules
- [ ] Add scripts to `package.json`:
  - `"test": "bun test"`
  - `"lint": "bunx biome check src/ tests/"`
  - `"lint:fix": "bunx biome check --write src/ tests/"`
  - `"typecheck": "tsc --noEmit"`
- [ ] Install TypeScript devDep for typecheck: `bun add --dev typescript`
- [ ] Update `CLAUDE.md`: add `### lint` and `### typecheck` sections near `### test` with usage commands
- [ ] Run `bun run lint` — fix any violations found (run `bun run lint:fix` first, then check)
- [ ] Run `bun run typecheck` — fix any type errors found
- [ ] Run `bun test` — confirm all tests still pass

## Files

- **package.json**: Add `test`, `lint`, `lint:fix`, `typecheck` scripts; Biome + TypeScript devDependencies
- **biome.json**: New file — Biome config with space indentation, recommended rules
- **CLAUDE.md**: Add lint and typecheck command sections
