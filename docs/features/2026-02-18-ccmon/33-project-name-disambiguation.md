# Phase 33: Project Name Disambiguation

## Context

See [00-ccmon](00-ccmon.md). When multiple projects share the same leaf directory name (e.g. `projectA/backend` and `projectB/backend`), they both appear as "backend" in the dashboard and are indistinguishable via `--project` CLI filter. Disambiguate `projectName` directly by expanding with parent path segments until unique.

## Questions & Investigations

- Q1: Should disambiguation run after stale filtering (callers do it) or inside `getProjectState()`?
  - Inside `getProjectState()` is simpler but stale-filtered views may show unnecessarily long names (e.g. `projectA/backend` when `projectB/backend` was already filtered out). Acceptable tradeoff — the name is still correct, just verbose.

## Tasks

### Backend

- [x] Implement `disambiguateProjectNames(projects: ProjectState[])` in `src/sessions.ts`
  - Group projects by `projectName` (basename)
  - For groups with duplicates, expand `projectName` by prepending parent dir segments from `cwd` until unique
  - Use `/` as separator (e.g. `projectA/backend`)
  - Projects with unique basenames keep their short name unchanged
- [x] Call `disambiguateProjectNames()` in `getProjectState()` after building all states
  - On targeted refresh path, resets all cached projectNames to basename first, then re-runs disambiguation on full cache
- [x] Add unit tests for `disambiguateProjectNames` (5 tests):
  - Two projects same basename, different parents → both get `parent/leaf` projectName
  - Three projects needing 2+ segments to disambiguate
  - Mix of unique and duplicate names: unique ones keep basename
  - Single project (no disambiguation needed)
  - Re-run resets stale names when duplicate removed

### Frontend

- [x] Switch `projKey()` to use `projectDir` instead of `projectName` for composite key
  - `p._backendKey + '::' + (p.projectDir || p.projectName)` — stable across renames
  - Fixes all 5 state maps + lastSortOrder cache
- [x] Multi-backend hostname prefix (R58 `nameCounts`) — verified it correctly layers on top (uses `projectName` for display collision, not key)

### CLI

- [x] `--project` filter already matches `projectName` — works with expanded names, no change needed

### Validation

- [x] Run lint + typecheck + tests — 218 tests pass, all clean

## Files

- **src/sessions.ts**: Added `disambiguateProjectNames()` function; integrated into both paths of `getProjectState()`
- **public/index.html**: `projKey()` uses `projectDir` instead of `projectName`
- **tests/sessions.test.ts**: 5 new tests for disambiguation function
