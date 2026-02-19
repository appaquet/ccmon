# Phase: Session Detection

## Context

See [00-ccmon](00-ccmon.md). Implement logic to enumerate Claude Code sessions from `~/.claude/projects/`, determine liveness via layered status+process detection, and watch for changes in real-time.

Key finding: directory name encoding is lossy (hyphens ambiguous), so `cwd` is read from the first line of the most recent JSONL session file instead.

## Tasks

### Setup

* [ ] Initialize `package.json` with Bun (`bun init`), `"type": "module"`, add `@types/bun` devDependency
* [ ] Add `tsconfig.json` for IDE support (target ESNext, moduleResolution bundler)

### scanProjects()

* [ ] Scan `~/.claude/projects/` for subdirectories (R1)
* [ ] For each subdir, find the most recently modified `.jsonl` file (ignore non-JSONL files and `subagents/` subdirs) (R1)
* [ ] Read and parse the first line of that JSONL file to extract `cwd`, `sessionId`, `gitBranch` (R1, R1.1)
* [ ] Derive `projectName` from last segment of `cwd` (R1.2)
* [ ] Return list of `{ projectDir, cwd, projectName, sessionId, latestJSONL }` (R1)
* [ ] Handle edge cases: empty project dirs, corrupt/empty JSONL, no JSONL files (R1)

### readStatus()

* [ ] Read `status.local.json` from `~/.claude/projects/{projectDir}/` (R2)
* [ ] Parse and return `{ state, timestamp, session_id, cwd }` or `null` if file missing/unreadable (R2)
* [ ] Validate that `state` is one of known states: `running`, `waiting_for_answer`, `waiting_for_permission`, `stopped` (R2)

### checkLiveness()

* [ ] Run `pgrep -a claude` via `Bun.spawnSync` to find running Claude processes (R2)
* [ ] For NixOS compatibility, also check `/proc/*/exe` symlinks for `.claude-wrapped` binary (R2)
* [ ] For each found process, read `/proc/{pid}/cwd` symlink to get its working directory (R2)
* [ ] Cross-reference process cwds with project cwds: if process found → session is live (R2)
* [ ] If no matching process and status timestamp > 5min stale and state !== `stopped` → override to `stopped` (R2.1)

### watchForChanges()

* [ ] Watch `~/.claude/projects/` directory for new subdirectory additions (fs.watch, non-recursive) (R1)
* [ ] Watch each known `status.local.json` file for modifications (R2)
* [ ] Debounce change callbacks by 100ms to handle duplicate inotify events (R2)
* [ ] On new project dir detected, run scanProjects() for that dir and start watching its status file (R1)
* [ ] Call `onUpdate(projectDir)` callback on any relevant change (R2)

### getProjectState()

* [ ] Aggregate scanProjects + readStatus + checkLiveness into a single state object per project (R1, R2)
* [ ] Return `{ projectDir, cwd, projectName, sessionId, state, lastUpdated }` (R1, R2)
* [ ] Export as the primary API for the backend phase to consume (R1, R2)

### Tests

* [ ] Unit test `scanProjects()` with temp dir mimicking `~/.claude/projects/` structure (mock JSONL files with valid first lines) using `bun:test` (R1)
* [ ] Unit test `readStatus()` with mock `status.local.json` files (valid, missing, corrupt) (R2)
* [ ] Unit test `checkLiveness()` with mocked `Bun.spawnSync` and `/proc` reads (R2)
* [ ] Manual integration test: run `bun run src/sessions.ts`, verify projects listed with correct state (R1, R2)

## Files

- **package.json**: Bun project config, `"type": "module"`, `@types/bun` devDep
- **tsconfig.json**: IDE TypeScript support (ESNext, moduleResolution bundler)
- **src/sessions.ts**: Core module — scanProjects(), readStatus(), checkLiveness(), getProjectState()
- **src/watcher.ts**: watchForChanges() — fs.watch logic, debouncing, new-project detection
- **tests/sessions.test.ts**: Unit tests using bun:test
