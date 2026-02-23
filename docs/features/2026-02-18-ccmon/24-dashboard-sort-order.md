# Phase: Dashboard Sort Order

## Context

See [00-ccmon](00-ccmon.md). Projects are currently sorted alphabetically by `projectName`. Replace with time-based sort (most recently active first), throttled to re-sort every 30s to avoid constant card reordering.

## Tasks

- [ ] Add `lastSortOrder` array and `lastSortTime` timestamp as module-level state in frontend
- [ ] Create `getSortedProjects(projects)` function: if 30s elapsed since `lastSortTime`, re-sort by `lastUpdated` descending and cache; otherwise reorder `projects` to match cached `lastSortOrder` (by composite key), appending any new projects at top
- [ ] Replace both `localeCompare` sorts in `mergeAndRender()` and `render()` with `getSortedProjects()` call (single call site, remove duplicate sort)
- [ ] Visual verification: run `bun run serve`, confirm most recently active projects appear first, and card order only changes every ~30s

## Files

- **public/index.html**: `getSortedProjects()` function, `lastSortOrder`/`lastSortTime` state, replace sort in `mergeAndRender()`/`render()`
