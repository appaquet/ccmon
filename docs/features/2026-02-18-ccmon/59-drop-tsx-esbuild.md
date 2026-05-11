# 59 Phase: Drop tsx & esbuild — Run TS Natively

## Context

See [00-ccmon](00-ccmon.md). Follow-up to [55-migrate-to-node](55-migrate-to-node.md), which kept `tsx` because all relative imports were extensionless and Node's native type-stripping does not perform extension resolution. Now switch to plain `node src/cli/main.ts ...` by adding `.ts` extensions to every relative import. Also drop `esbuild` and the `dist/cli.js` bundle: nothing actually depends on it apart from the Nix `buildNpmPackage` `bin` entry, which can point at `src/cli/main.ts` directly under Node 22's default type-stripping.

## Requirements

- R99.A: `tsx` and `esbuild` are removed from `devDependencies`; `package.json` build script removed
- R99.B: `bin` entry resolves to `src/cli/main.ts`; `files` ships `src/` + `public/` (no `dist/`)
- R99.C: All 4 npm scripts (`dump`, `status`, `serve`, `sub`) invoke `node src/cli/main.ts`
- R99.D: `tsconfig.json` uses `module: "nodenext"`, `moduleResolution: "nodenext"`, `allowImportingTsExtensions: true`, `noEmit: true`
- R99.E: All relative imports in `src/` and `tests/` use explicit `.ts` extensions (no extensionless, no `.js`-pointing-at-`.ts`)
- R99.F: `nix build` produces a working `ccmon` binary; `./result/bin/ccmon dump --no-filter` returns project data
- R99.G: TypeScript parameter properties (`constructor(private x: T)`) rewritten as explicit field declarations (Node's strip-only TS doesn't support them)

## Questions & Investigations

- [x] Q: Use `.ts` extensions or `.js`-pointing-at-`.ts`?
  - Uncertainty: TypeScript convention is `.js` for compatibility with `tsc --outDir` emit
  - Result: `.ts` chosen. ccmon has no `tsc` emit path (typecheck is `--noEmit`, production bundle was esbuild and is being dropped). `.ts` matches reality on disk and is what Node's strip-types resolver expects. Cost: `allowImportingTsExtensions: true` in tsconfig, which forces `noEmit: true` — already the case
- [x] Q: Drop esbuild entirely or keep bundle for production bin?
  - Uncertainty: Whether HTML serving or any other code path depended on the bundle
  - Tried: grep across `src/`, `flake.nix`, CI, README — esbuild references only in `package.json` (build script + bin) and `flake.nix:buildNpmPackage` consumption via `bin`. HTML/`public/js/` files are served as static reads at runtime (`src/server.ts:19`) — esbuild was never involved
  - Result: Drop the bundle. `bin: src/cli/main.ts`, Nix wrapper invokes Node on source, type-stripping happens at load. `NODE_NO_WARNINGS=1` already set in `flake.nix:24-28` silences the experimental warning
- [x] Q: Hook-invocation latency under direct .ts execution?
  - Uncertainty: Cold-start cost of type-stripping the full import graph on every `ccmon status` invocation (hooks fire frequently)
  - Result: ~111ms median on Nix-built binary (10 runs); ~99ms median running `node src/cli/main.ts` directly from project. Within the 50ms regression budget. Hooks fire per-event, not per-tick — acceptable
- [x] Q: `moduleResolution` value — `"node"` or `"nodenext"`?
  - Uncertainty: First research pass suggested `"node"` (legacy CJS resolution)
  - Result: `"nodenext"` — required when paired with `allowImportingTsExtensions: true` and matches Node's actual ESM resolver. Forces `module: "nodenext"` too
- [x] Q: Does `buildNpmPackage` in `flake.nix` need changes beyond `npmDepsHash`?
  - Uncertainty: Default behavior of `buildNpmPackage` when the `build` script is absent
  - Tried: Inspected the local `nodejs_22` pin (22.22.2 — type-stripping default-on, no flag needed). Reviewed nixpkgs `buildNpmPackage` defaults
  - Result: Must add `dontNpmBuild = true;`. Default behavior runs `npm run build` and fails with "Missing script: build" once Task 3 removes it. With this flag, the build phase becomes a no-op
- [x] Q: `bin: src/cli/main.ts` works in a Nix-installed package?
  - Uncertainty: Whether Node's type-stripping works when the script sits under `node_modules/`
  - Tried: Built with `bin: src/cli/main.ts` and `buildNpmPackage`. Failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — Node refuses to strip types from files anywhere under `node_modules/` (deliberate, hardcoded guardrail, no escape flag)
  - Result: `flake.nix` postInstall copies `src/` and `public/` to `$out/share/ccmon/` (outside node_modules), symlinks `node_modules` next to them for `ws` resolution, and rewrites the bin wrapper to invoke `node $out/share/ccmon/src/cli/main.ts`. Also pinned `nodejs = pkgs.nodejs_22` since `buildNpmPackage` defaults to latest (was picking up nodejs_24)

## Tasks

### [x] 1. Update tsconfig.json (R99.D)

- `module: "esnext"` → `"nodenext"`
- `moduleResolution: "bundler"` → `"nodenext"`
- Add `allowImportingTsExtensions: true`
- Add `noEmit: true` (required by previous flag)
- Add `verbatimModuleSyntax: true` (enforces `import type` discipline; current code already complies)
- AC: `npm run typecheck` reports new errors on extensionless relative imports — confirms config is active and migration is needed

### [x] 2. Rewrite all relative imports to `.ts` (R99.E)

- Codemod across `src/**/*.ts` and `tests/**/*.ts`:
  - `from "./X"` → `from "./X.ts"` (where X has no extension)
  - `from "../X"` → `from "../X.ts"` (same pattern)
  - `from "./X.js"` → `from "./X.ts"` (9 bun-era artifacts, all `timing.js`)
- Preserve `node:*` and external imports (`ws`, `vitest`, etc.) unchanged
- Also caught: two inline dynamic type imports in `build-project-state.ts` (`import("../types").X`) and two directory imports that resolved to `/index.ts` (in `dump.ts`, `serve.ts`)
- Sanity check: grep for remaining extensionless or `.js`-suffixed relative imports — returned zero
- Result: 29 files modified, 116 import lines changed
- AC: `npm run typecheck` passes with 0 errors ✓

### [x] 3. Update package.json (R99.A, R99.B, R99.C)

- Remove `"build": "esbuild ..."` script
- Remove `esbuild` and `tsx` from `devDependencies`
- Change `"bin": { "ccmon": "dist/cli.js" }` → `"bin": { "ccmon": "src/cli/main.ts" }`
- Change `"files": ["dist", "public"]` → `["src", "public"]`
- Rewrite 4 scripts: `tsx src/cli/main.ts X` → `node src/cli/main.ts X` (dump, status, serve, sub)
- Run `npm install` to regenerate `package-lock.json`
- AC: `node_modules/.bin/` contains neither `tsx` nor `esbuild`; `package-lock.json` shows the removals

### [x] 4. Smoke-test dev scripts (R99.A,C)

- `npm run dump --no-filter` → returns ≥1 project as JSON (CLAUDE.md integration check)
- `npm run dump` → stale filter applied
- `npm run serve` starts; `curl http://localhost:8080/api/state` returns valid JSON
- Status hook simulation: `echo '{"session_id":"x","cwd":"/tmp","hook_event_name":"Stop"}' | node src/cli/main.ts status` writes `/tmp/ccmon-status.jsonl`
- AC: all four commands succeed; no Node experimental warning visible in normal output (silenced by `NODE_NO_WARNINGS` in Nix; ok visible in raw dev)

### [x] 5. Full verification suite

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes (304 tests, 10 files)
- AC: green across the board

### [x] 6. Nix flake build + cleanup (R99.F)

- **Add `dontNpmBuild = true;`** to the `buildNpmPackage` block in `flake.nix:20-29`. Without this, `buildNpmPackage` defaults to running `npm run build` and will fail with `Missing script: build` after Task 3 removes the script. The bin path resolves directly to the source `.ts` file — no build step is required.
- **Recompute `npmDepsHash`**: set to `""`, run `nix build .#ccmon`, copy the SHA from the "got: …" line of the hash mismatch error, paste back, rebuild.
- **Verify the wrapped binary**:
  - `./result/bin/ccmon dump --no-filter` → returns project data
  - `./result/bin/ccmon --version` → prints `ccmon 0.1.0`
  - Check that the shebang on the bin target is honored: `head -1 ./result/lib/node_modules/ccmon/src/cli/main.ts` shows `#!/usr/bin/env node`, and the file has `+x` (npm sets this during install)
- **Optional defensive change** (skip unless `nodejs_22` pin moves below 22.18 in a future nixpkgs bump): add `"--set" "NODE_OPTIONS" "--experimental-strip-types"` to `makeWrapperArgs`. Currently 22.22.2 → default-on, no-op. Documenting for future-proofing only.
- **`.gitignore` cleanup**: remove obsolete entries `dist/`, `build/`, `.bun/`
- AC: `nix build` succeeds without `Missing script: build` error; built binary returns project data and version; no warning visible in normal output (NODE_NO_WARNINGS already set)

### [x] 7. Hook latency benchmark (deferred to follow-up if regressed)

- Time `echo '{"session_id":"x","cwd":"/tmp","hook_event_name":"Stop"}' | ./result/bin/ccmon status` 10x, take median
- Compare against `git stash` of current bundled build (or measure pre-migration commit via `jj prev`)
- AC: median regression <50ms; if exceeded, file follow-up phase to re-add a minimal bundle step (keep esbuild as devDep only)

## Files

- **tsconfig.json**: `module` and `moduleResolution` → `nodenext`; add `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`
- **package.json**: remove `build` script, `esbuild`, `tsx`; `bin` → `src/cli/main.ts`; `files` → `["src", "public"]`; 4 scripts switch from `tsx` to `node`
- **package-lock.json**: regenerated after dependency removals
- **src/*.ts** (15 files): relative imports rewritten with `.ts` extensions
- **src/cli/**/*.ts** (6 files): same
- **src/backends/*.ts** (6 files): same
- **src/parsers/*.ts** (2 files): same
- **tests/**/*.ts** (10 files): same
- **flake.nix**: pin `nodejs = pkgs.nodejs_22`; add `dontNpmBuild = true;`; add `postInstall` that copies `src/`+`public/` to `$out/share/ccmon/` (outside `node_modules/` to satisfy Node's type-strip restriction), symlinks `node_modules/`, and rewrites the bin wrapper to invoke `node` on the new path
- **src/backends/claude.ts**: parameter property `constructor(private claudeDir: string)` rewritten as explicit field + assignment (R99.G)
- **src/backends/opencode.ts**: parameter property constructor (4 params) rewritten as explicit fields + assignments (R99.G)
- **tests/server.test.ts**: `NoWatchBackend` parameter property constructor rewritten (R99.G)
- **tests/cli.test.ts**: removed `npx tsx` invocation and 5 `--import tsx/esm` Node flag arrays; now invokes `node ${CLI_PATH}` directly
- **.gitignore**: removed `dist/`, `build/`, `.bun/` (obsolete after bundle drop and bun migration)
