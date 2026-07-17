# ccmon fixes

## Context

Track and deliver a series of focused fixes to ccmon. The initial work addresses recent OpenCode status behavior that does not work correctly for sub-agent sessions.

## Checkpoint

The project skeleton is initialized. The next step is to plan the OpenCode sub-agent status phase with `proj-plan` before implementation begins.

## Requirements

* R1: ⬜ OpenCode status behavior works correctly for sub-agent sessions following the latest status-related changes. (Phase: OpenCode sub-agent status)

## Phases

### ⬜ 01 Phase: OpenCode sub-agent status

[01-opencode-subagent-status](01-opencode-subagent-status.md)

Investigate and fix the recent OpenCode status regression affecting sub-agent sessions. Detailed requirements, design, tasks, and acceptance criteria will be established during planning.

## Files

- **src/backends/opencode.ts**: OpenCode backend context for the initial phase.
- **tests/backends/opencode.test.ts**: OpenCode backend test coverage relevant to the initial phase.
