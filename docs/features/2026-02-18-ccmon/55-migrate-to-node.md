# 55 Phase: Migrate from Bun to Node.js

## Context

See [00-ccmon](00-ccmon.md). Replace Bun runtime with Node.js 22 LTS. Bun has sandbox issues on NixOS (process.env empty — see `src/env.ts` workaround) and other bugs. Node.js 22.18+ runs TypeScript natively via Amaro type stripping — no transpiler needed.

## Requirements

- R77: All source code runs on Node.js 22 LTS without Bun runtime
  - R77.1: `node src/cli.ts <subcommand>` works identically to `bun run src/cli.ts <subcommand>`
  - R77.2: No `Bun.*` API calls remain in production code
  - R77.3: No `bun:` prefixed imports remain
- R78: Tests run on `vitest` (same expect/describe API as bun:test)
  - R78.1: All existing tests pass with same assertions
  - R78.2: `npm test` runs all test files
- R79: Nix flake exposes ccmon via Node.js 22, not bun
  - R79.1: `nix build` succeeds
  - R79.2: `nix develop` provides nodejs_22 shell
- R80: CI uses Node.js 22, not bun
- R81: `npm run lint`, `npm run typecheck`, `npm test` all pass
- R82: `src/env.ts` Bun sandbox workaround removed (Node.js process.env works correctly in sandbox)

### API Replacement Map

| Bun API | Node.js Replacement | Files |
|---------|-------------------|-------|
| `Bun.file(path)` / `.text()` | `readFileSync(path, 'utf-8')` | src/sessions.ts, src/session-core.ts |
| `Bun.file(path).slice(-N)` | `readFileSync` with position/offset + size check | src/session-core.ts |
| `Bun.write(path, contents)` | `writeFileSync(path, contents, 'utf-8')` | src/sessions.ts |
| `Bun.env` | `process.env` | src/cli.ts, tests/_helpers.ts |
| `Bun.stdin.stream()` → `new Response().text()` | `readFileSync(process.stdin.fd, 'utf-8')` | src/cli.ts |
| `Bun.serve({...})` | `http.createServer(...)` + `ws` WebSocketServer | src/server.ts |
| `import type { ServerWebSocket } from "bun"` | `import type { WebSocket } from "ws"` | src/server.ts |
| `import { Database } from "bun:sqlite"` | `import Database from "better-sqlite3"` | src/backends/index.ts, src/backends/opencode.ts, tests |
| `import.meta.dir` | `fileURLToPath(import.meta.url)` → `dirname()` | src/server.ts, tests/cli.test.ts |
| `import { ... } from "bun:test"` | `import { ... } from "vitest"` | 7 test files |
| `Bun.sleep(ms)` (tests) | `await new Promise(r => setTimeout(r, ms))` | 5 test files |
| `Bun.spawn([...])` (tests) | `spawnSync(...)` from `node:child_process` | tests/cli.test.ts |

### better-sqlite3 API Differences

| bun:sqlite | better-sqlite3 |
|-----------|----------------|
| `import { Database } from "bun:sqlite"` | `import Database from "better-sqlite3"` |
| `db.query(sql)` → `.all()` / `.get()` | `db.prepare(sql)` → `.all()` / `.get()` |
| `db.query(sql).all(...args)` | `db.prepare(sql).all(...args)` |
| `db.query(sql).get(...args)` | `db.prepare(sql).get(...args)` |
| `db.run(sql)` | `db.prepare(sql).run()` |
| `db.close()` | `db.close()` (same) |
| `{ readonly: true }` option | `{ readonly: true }` (same) |

better-sqlite3 is synchronous — opencode backend methods are async wrappers but all db calls are sync internally. Zero behavior change, no event loop impact (queries are sub-millisecond).

## Questions & Investigations

- Q8: Can Node.js 22.18+ run all our TypeScript? → Confirmed: no `enum`/`namespace` in codebase, only 2 `import.meta.dir` to replace. 100% erasable syntax.
- Q9: Availability of better-sqlite3 in nixpkgs? → Ships prebuilt binaries for Linux x64; `npm install` should work. If native compilation fails in nix sandbox, need to add `pkgs.nodePackages.better-sqlite3` to flake.
- Q10: Does Node.js process.env work correctly inside nono sandbox? → Need to verify. Bun bug linked to `Bun.env` special handling; `process.env` in Node reads `/proc/self/environ` natively. Expected to work.

## Tasks

### [x] 1. Replace package.json, switch to npm

- Replace `@types/bun` with `@types/better-sqlite3` and `@types/ws` devDependencies
- Add `better-sqlite3`, `ws`, `vitest` as dependencies
- Update scripts: `bun run` → `node`, `bun test` → `vitest run`, `bunx` → `npx`
- Run `npm install` to generate `package-lock.json`
- Delete `bun.lock`
  - AC: `npm install` succeeds, `node_modules/` has all deps

### [x] 2. Replace Bun.file / Bun.write with node:fs

- `src/sessions.ts`: 8 `Bun.file`/`Bun.write` calls → `readFileSync`/`writeFileSync`
  - `.slice(0, 4096)` → `readFileSync(path, {encoding: 'utf-8'}).slice(0, 4096)` or fd-based read with position
  - `.slice(-TAIL_BYTES)` → stat size first, then readFileSync with offset
- `src/session-core.ts`: 2 `Bun.file` calls
- Add `import { readFileSync, writeFileSync, statSync } from "node:fs"` where needed
  - AC: `npm run dump --no-filter` returns real project data (integration check from CLAUDE.md)

### [x] 3. Replace Bun.env with process.env

- `src/cli.ts:28`: `Bun.env.CLAUDE_PROJECTS_DIR` → `process.env.CLAUDE_PROJECTS_DIR`
- `tests/_helpers.ts:4` → same
  - AC: `npm run dump` reads CLAUDE_PROJECTS_DIR from env correctly

### [x] 4. Replace Bun.stdin.stream() with process.stdin

- `src/cli.ts:455`: `new Response(Bun.stdin.stream()).text()` → `readFileSync(process.stdin.fd, 'utf-8')`
  - AC: `echo '{"session_id":"x","cwd":"/tmp","hook_event_name":"Stop"}' | node src/cli.ts status` writes status file

### [x] 5. Replace import.meta.dir

- `src/server.ts:10`: → `dirname(fileURLToPath(import.meta.url))`
- `tests/cli.test.ts:10` → same
  - AC: Server starts and serves index.html; tests find CLI path

### [x] 6. Replace Bun.serve() with node:http + ws library

- Rewrite `startServer()` in `src/server.ts`:
  - `import { createServer } from "node:http"`
  - `import { WebSocketServer } from "ws"`
  - Replace `Bun.serve()` with `http.createServer()` + `new WebSocketServer({ noServer: true })`
  - HTTP routing via `req.method`/`req.url` + `res.writeHead`/`res.end`
  - WS upgrade via `wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))`
  - Replace `ServerWebSocket` type with `WebSocket` from `ws`
  - Replace `server.stop(true)` with `server.close()` + `wss.close()`
  - Replace `server.port` with resolved port from `server.address()`
  - AC: `npm run serve` starts; WebSocket connects; `npm run sub` receives state

### [x] 7. Replace bun:sqlite with better-sqlite3

- `src/backends/index.ts`: `import { Database } from "bun:sqlite"` → `import Database from "better-sqlite3"`
  - `db.run("PRAGMA...")` → `db.pragma("busy_timeout = 5000")`
- `src/backends/opencode.ts`: `import type { Database } from "bun:sqlite"` → `import type Database from "better-sqlite3"`
  - `db.query(sql).all()` → `db.prepare(sql).all()`
  - `db.query(sql).get()` → `db.prepare(sql).get()`
- `tests/backends/opencode.test.ts`: same import + API changes
- `tests/integration.test.ts`: same
  - AC: OpenCode backend tests pass

### [x] 8. Replace bun:test with vitest

- 7 test files: `import { ... } from "bun:test"` → `import { ... } from "vitest"`
- `tests/watcher.test.ts`: `mock` → `vi.fn()` (import `vi` from `vitest`)
- Add optional `vitest.config.ts` if needed (likely not — vitest works zero-config with TypeScript)
  - AC: `npm test` runs all tests, same count passes

### [x] 9. Replace Bun.sleep / Bun.spawn in tests

- All `Bun.sleep(ms)` → `await new Promise(r => setTimeout(r, ms))` (5 test files, ~30 calls)
- `tests/cli.test.ts`: `Bun.spawn([...])` → `spawnSync(...)` or `execSync(...)` from `node:child_process`
  - AC: Tests involving timing/spawning pass

### [x] 10. Update config files

- `flake.nix`: `pkgs.bun` → `pkgs.nodejs_22` in both `ccmon` wrapper and `devShell`
- `.github/workflows/ci.yml`: `oven-sh/setup-bun@v1` → `actions/setup-node@v4` with `node-version: 22`; `bun install` → `npm ci`; `bun run lint` → `npm run lint`; `bun run typecheck` → `npm run typecheck`; `bun test` → `npm test`
- `.github/dependabot.yml`: `package-ecosystem: "bun"` → `package-ecosystem: "npm"`
- `tsconfig.json`: Remove `moduleResolution: "bundler"` (was only needed for bun: imports); change to `"node16"` or remove (N/A — Amaro strips types, doesn't use tsconfig at runtime)
- `biome.json`: no changes needed (formatter/linter are runtime-agnostic)
  - AC: `nix build` succeeds; CI config is syntactically valid

### [x] 11. Remove or reduce src/env.ts

- Node.js `process.env` reads `/proc/self/environ` natively — sandbox workaround no longer needed
- Delete the file, remove `import { restoreProcessEnv } from "./env"` + `restoreProcessEnv()` from `src/cli.ts`
- If nono sandbox causes same issue with Node (unlikely but possible), keep a reduced version
  - AC: `npm run dump` works without env.ts hack

### [x] 12. Update documentation

- `CLAUDE.md`: Replace all `bun` references with `node`/`npm` equivalents in Commands section, Architecture section, Setup section, and integration check commands
- `README.md`: Update install instructions (remove bun prerequisite, add Node 22 prerequisite)
- Phase doc: Update 00-ccmon.md `R3` to reference node instead of bun where applicable
  - AC: Documentation is accurate for the new runtime

### [x] 13. Full verification

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes (all tests green)
- Integration check (from CLAUDE.md): `npm run dump --no-filter` returns ≥1 project
- `npm run serve` starts, dashboard loads, WebSocket connects
  - AC: All verification steps pass

## Files

- **package.json**: devDependencies replaced (@types/bun → @types/better-sqlite3, @types/ws); deps added (better-sqlite3, ws, vitest); scripts updated (bun → node/npm equivalents)
- **bun.lock**: Deleted; replaced by package-lock.json
- **src/cli.ts**: Bun.env → process.env; Bun.stdin → process.stdin; restoreProcessEnv removed
- **src/server.ts**: Bun.serve → http.createServer + WebSocketServer; import.meta.dir → fileURLToPath; ServerWebSocket → ws types
- **src/sessions.ts**: Bun.file/Bun.write → readFileSync/writeFileSync
- **src/session-core.ts**: Bun.file → readFileSync
- **src/env.ts**: Deleted or reduced
- **src/backends/index.ts**: bun:sqlite → better-sqlite3; db.run → db.pragma
- **src/backends/opencode.ts**: bun:sqlite → better-sqlite3; query().all() → prepare().all()
- **tests/_helpers.ts**: Bun.env → process.env
- **tests/*.test.ts** (7 files): bun:test → vitest imports
- **tests/watcher.test.ts**: mock → vi.fn()
- **tests/cli.test.ts**: Bun.spawn → spawnSync; import.meta.dir → fileURLToPath; Bun.sleep → setTimeout
- **tests/server.test.ts**: Bun.sleep → setTimeout
- **tests/sessions.test.ts**: Bun.sleep → setTimeout; Bun.file/Bun.write → node:fs
- **tests/backends/opencode.test.ts**: bun:sqlite → better-sqlite3; Bun.sleep → setTimeout
- **tests/integration.test.ts**: bun:sqlite → better-sqlite3 type
- **flake.nix**: pkgs.bun → pkgs.nodejs_22
- **.github/workflows/ci.yml**: setup-bun → setup-node; bun commands → npm equivalents
- **.github/dependabot.yml**: bun → npm ecosystem
- **CLAUDE.md**: Command references, architecture, setup instructions
- **README.md**: Install prerequisites
