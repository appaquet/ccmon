# Phase: Session Detection

## Context

See [00-ccmon](00-ccmon.md). Implement logic to enumerate Claude Code sessions from `~/.claude/projects/`, determine liveness via layered status+process detection, and watch for changes in real-time.

Key finding: directory name encoding is lossy (hyphens ambiguous), so `cwd` is read from the first line of the most recent JSONL session file instead.

TDD approach: write tests first, implement, verify `bun test` passes before moving on.

## Tasks

Implementation order is designed for TDD — each step writes a test, then implements until it passes.

### Step 1: Project setup

* [ ] Initialize `package.json` with Bun (`bun init`), `"type": "module"`, add `@types/bun` devDependency
* [ ] Add `tsconfig.json` for IDE support (target ESNext, moduleResolution bundler)
* [ ] Create `CLAUDE.md` at project root with build/run/test instructions
  * Include: `bun install`, `bun test`, `bun run dump`
  * Note: this file should be improved/maintained across all phases
* [ ] Add `"dump"` script in `package.json`: `"bun run src/cli.ts dump"`
* [ ] Verify: `bun test` runs (even if no tests yet)

### Step 2: scanProjects() — TDD

* [ ] Write test for `scanProjects()` in `tests/sessions.test.ts` using temp dir mimicking `~/.claude/projects/` structure (R1)
  * Mock: create temp dirs with JSONL files containing valid first lines with `cwd`, `sessionId`, `gitBranch`
  * Test: returns correct `projectDir`, `cwd`, `projectName`, `sessionId`, `latestJSONL`
  * Test edge cases: empty dir, corrupt JSONL, no JSONL files, multiple JSONL files (picks most recent)
* [ ] Implement `scanProjects()` in `src/sessions.ts` (R1, R1.1, R1.2)
  * Scan `~/.claude/projects/` for subdirectories
  * For each subdir, find most recently modified `.jsonl` file (ignore non-JSONL, `subagents/` subdirs)
  * Read first line, parse JSON, extract `cwd`, `sessionId`, `gitBranch`
  * Derive `projectName` from last segment of `cwd`
  * Return `{ projectDir, cwd, projectName, sessionId, latestJSONL }`
* [ ] Verify: `bun test` passes for scanProjects

### Step 3: readStatus() — TDD

* [ ] Write test for `readStatus()` (R2)
  * Test: valid `status.local.json` → returns `{ state, timestamp, session_id, cwd }`
  * Test: missing file → returns `null`
  * Test: corrupt JSON → returns `null`
  * Test: unknown state → returns `null`
* [ ] Implement `readStatus()` in `src/sessions.ts` (R2, R2.1)
  * Read `status.local.json` from `~/.claude/projects/{projectDir}/`
  * Validate `state` is one of: `running`, `waiting_for_answer`, `waiting_for_permission`, `stopped`
* [ ] Verify: `bun test` passes for readStatus

### Step 4: checkLiveness() — TDD

* [ ] Write test for `checkLiveness()` with mocked process detection (R2, R2.2)
  * Test: process found for a project's cwd → reports live
  * Test: no process, stale status → override to stopped
  * Test: no process, recent status → keep current state
* [ ] Implement `checkLiveness()` in `src/sessions.ts` (R2, R2.2)
  * Run `pgrep -a claude` via `Bun.spawnSync`
  * Also check `/proc/*/exe` for `.claude-wrapped` (NixOS)
  * Read `/proc/{pid}/cwd` symlink for each matched process
  * Cross-reference with project cwds
  * Stale threshold: 5 minutes
* [ ] Verify: `bun test` passes for checkLiveness

### Step 5: getProjectState() — TDD

* [ ] Write test for `getProjectState()` aggregating scan + status + liveness (R1, R2)
* [ ] Implement `getProjectState()` in `src/sessions.ts`
  * Returns `{ projectDir, cwd, projectName, sessionId, state, lastUpdated }` per project
* [ ] Verify: `bun test` passes for getProjectState

### Step 6: CLI dump command

* [ ] Implement `src/cli.ts` with `dump` subcommand (R1, R2)
  * Calls `getProjectState()` for all projects
  * Prints JSON to stdout (`JSON.stringify(state, null, 2)`)
  * Exit code 0 on success
* [ ] Verify: `bun run dump` outputs valid JSON with real project data
* [ ] User validation: run `bun run dump` and confirm output looks correct

### Step 7: watchForChanges() — TDD

* [ ] Write test for `watchForChanges()` (R1, R2)
  * Test: file change triggers onUpdate callback
  * Test: new project dir triggers scan + watch
  * Test: debounce works (multiple rapid changes → single callback)
* [ ] Implement `watchForChanges()` in `src/watcher.ts`
  * Watch `~/.claude/projects/` for new subdirectories (fs.watch, non-recursive)
  * Watch each `status.local.json` for modifications
  * Watch parent dir if `status.local.json` doesn't exist yet, switch to file watch when created
  * Debounce 100ms
  * Call `onUpdate(projectDir)` on change
* [ ] Verify: `bun test` passes for watchForChanges

## Files

- **CLAUDE.md**: Project development instructions (maintained across all phases)
- **package.json**: Bun project config, `"type": "module"`, `@types/bun`, `dump` script
- **tsconfig.json**: IDE TypeScript support (ESNext, moduleResolution bundler)
- **src/sessions.ts**: Core module — scanProjects(), readStatus(), checkLiveness(), getProjectState()
- **src/watcher.ts**: watchForChanges() — fs.watch logic, debouncing, new-project detection
- **src/cli.ts**: CLI entry point — `dump` subcommand outputs JSON state to stdout
- **tests/sessions.test.ts**: Unit tests using bun:test
