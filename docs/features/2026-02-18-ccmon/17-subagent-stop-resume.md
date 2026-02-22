# Phase: Sub-Agent Stop/Resume Fix

## Context

See [00-ccmon](00-ccmon.md). After a session stops and resumes (same session UUID), old sub-agents can briefly appear active because `getSubagentInfos()` uses a 45s mtime threshold with no awareness of session stop events.

## Questions

* Q1: Window is narrow (resume within 45s of sub-agent's last write), but could also be triggered if Claude Code touches sub-agent files during context reconstruction on resume.

## Tasks

- [ ] Pass `stoppedAtMs` (from status file) into `getSubagentInfos()` — sub-agents with mtime <= stoppedAtMs + STOP_GRACE_MS are never considered active (R40)
- [ ] Update `buildProjectState()` call site to pass the stopped timestamp (R40)
- [ ] Add test: sub-agent mtime 30s ago, stopped at 10s ago → `isActive === false` (R40)
- [ ] Add test: sub-agent mtime 5s ago, stopped at 10s ago → `isActive === true` (wrote after stop = new activity) (R40)
- [ ] Add test: no stopped signal (null) → existing 45s threshold behavior unchanged (R40)

## Files

- **src/sessions.ts**: `getSubagentInfos()` signature change, `buildProjectState()` call site update
- **tests/sessions.test.ts**: New tests for stopped-aware sub-agent detection
