# Phase 33: Project Name Disambiguation

## Context

See [00-ccmon](00-ccmon.md). When multiple projects share the same leaf directory name (e.g. `projectA/backend` and `projectB/backend`), they both appear as "backend" in the dashboard and are indistinguishable via `--project` CLI filter. Disambiguate `projectName` directly by expanding with parent path segments until unique.

## Questions

- Q1: Should disambiguation run after stale filtering (callers do it) or inside `getProjectState()`?
  - Inside `getProjectState()` is simpler but stale-filtered views may show unnecessarily long names (e.g. `projectA/backend` when `projectB/backend` was already filtered out). Acceptable tradeoff — the name is still correct, just verbose.

## Tasks

### Backend

- [ ] Implement `disambiguateProjectNames(projects: ProjectState[])` in `src/sessions.ts`
  - Group projects by `projectName` (basename)
  - For groups with duplicates, expand `projectName` by prepending parent dir segments from `cwd` until unique
  - Use `/` as separator (e.g. `projectA/backend`)
  - Projects with unique basenames keep their short name unchanged
- [ ] Call `disambiguateProjectNames()` in `getProjectState()` after building all states
  - CRITICAL: On targeted refresh path, disambiguation must re-run on ALL cached projects (mutate all entries in `projectStateCache`), not just the changed one — adding/removing one project can change the name of others
- [ ] Add unit tests for `disambiguateProjectNames`:
  - Two projects same basename, different parents → both get `parent/leaf` projectName
  - Three projects needing 2+ segments to disambiguate
  - Mix of unique and duplicate names: unique ones keep basename
  - Single project (no disambiguation needed)

### Frontend

- [ ] Switch `projKey()` to use `projectDir` instead of `projectName` for composite key
  - Current: `p._backendKey + '::' + p.projectName` — breaks when projectName changes
  - New: `p._backendKey + '::' + p.projectDir` — stable, unique per project per backend
  - This fixes all 5 state maps: `prevState`, `flashStopped`, `flashNotification`, `flashWaitingDismissed`, `prevNotificationTimestamp`
  - Also fixes `lastSortOrder` cache (prevents card position jumps on rename)
  - `projectDir` field already present in `ProjectState` — it's the encoded dir name from `~/.claude/projects/`
- [ ] Multi-backend hostname prefix (R58 `nameCounts`) — verify it correctly layers on top of disambiguated names

### CLI

- [ ] `--project` filter already matches `projectName` — works with expanded names, no change needed
  - Note: during `--watch`, if a project gets disambiguated mid-stream, output stops matching. Acceptable behavior — document in CLAUDE.md if needed

### Validation

- [ ] Run lint + typecheck + tests

## Files

- **src/sessions.ts**: Implement and call `disambiguateProjectNames()`; ensure targeted refresh re-disambiguates all cached projects
- **public/index.html**: Switch `projKey()` to use `projectDir`
- **tests/sessions.test.ts**: Unit tests for disambiguation function
