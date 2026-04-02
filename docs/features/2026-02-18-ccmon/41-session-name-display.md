# Phase 41: Session Name Display

## Context

See [00-ccmon](00-ccmon.md). Currently ccmon derives `projectName` from the directory basename (e.g. `backend3`). Claude Code supports user-assigned session names via `/rename` (e.g. `tableoutput`). These names are stored in JSONL transcripts as `{"type":"custom-title","customTitle":"..."}` lines, repeated throughout the file. ccmon should extract and display these.

## Questions & Investigations

- [x] Q: Where are session names stored?
  - `custom-title` lines in JSONL transcripts (persistent, repeated throughout file)
  - `agent-name` lines alongside (same value)
  - `~/.claude/sessions/{pid}.json` `name` field (live sessions only, deleted on exit)
  - NOT in `sessions-index.json`
- [x] Q: Per-session or per-project?
  - Per-session. ccmon picks the latest session per project dir, so we use that session's name
- [x] Q: UI display decision?
  - `backend3 (tableoutput)` — session name in parentheses, non-bolded, only when present

## Tasks

### Backend

- [x] Add `sessionName?: string` to `SessionEnrichment` interface
  - AC: Field exists on the type, optional
- [x] Parse `custom-title` lines in `scanEnrichment()` reverse pass
  - AC: When JSONL contains `{"type":"custom-title","customTitle":"X"}`, enrichment.sessionName === "X"
  - AC: First hit in reverse scan wins (most recent name)
  - AC: When no `custom-title` line exists, sessionName is undefined
- [x] Surface `sessionName` in `ProjectState`
  - AC: `sessionName` from enrichment flows through to ProjectState output
  - Note: ProjectState extends SessionEnrichment, so no separate field needed

### UI

- [x] Show session name in card header as `projectName (sessionName)` when present
  - AC: When sessionName exists, card header shows `backend3 (tableoutput)` with parenthesized part non-bolded
  - AC: When sessionName is absent, card header shows just `projectName` as before

### Tests

- [x] Unit test: JSONL with `custom-title` line -> enrichment has sessionName
- [x] Unit test: JSONL without `custom-title` -> sessionName undefined
- [x] Unit test: Multiple `custom-title` lines -> most recent one wins

### Validation

- [x] Integration: `bun run dump --no-filter` shows sessionName for backend3 project
- [x] Lint + typecheck + full test suite passes (235 tests)

## Files

- **src/sessions.ts**: Add `sessionName` to SessionEnrichment and ProjectState; parse `custom-title` in scanEnrichment()
- **public/index.html**: Card header display logic for session name
- **tests/sessions.test.ts**: Unit tests for custom-title parsing
