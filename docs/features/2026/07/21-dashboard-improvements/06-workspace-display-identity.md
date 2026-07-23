# Phase 06: Workspace Display Identity

## Context

Sessions whose cwd is under `.workspaces/<name>` should display `<filesystem-root>/<workspace>` rather than a backend-specific or trailing-directory label. This remains separate from Phase 05 because it changes project display-name derivation and same-host/cross-host disambiguation, while `.local` shortening is frontend-only hostname presentation.

Canonical cwd, project name, session ID, source, and backend identity remain unchanged. The derived `displayName` intentionally changes in HTTP, WebSocket, and dump output because those surfaces expose presentation data; tests must prove no canonical field changes alongside it.

## Requirements

* R12.A: 🔄 Detect an exact `.workspaces/<workspace>` cwd segment and display `<filesystem-root>/<workspace>`.
* R12.B: 🔄 Preserve the workspace label when cwd points inside a workspace subdirectory.
* R12.C: 🔄 Use workspace-aware labels in same-host and cross-host display disambiguation without changing canonical identity.
* R12.D: 🔄 Preserve existing behavior for ordinary paths, incomplete markers, non-segment text, and empty workspace names.
* R12.E: 🔄 Propagate only the derived workspace-aware `displayName` through HTTP, WebSocket, and dump output while preserving canonical fields byte-for-byte.

## Design

Use a pure server-side display helper that recognizes `.workspaces` only as a complete path segment followed by a nonempty workspace segment. The segment immediately before `.workspaces` supplies the filesystem-root label; deeper cwd segments do not change the base label. Feed logical display segments into existing disambiguation while retaining raw fields for keys and protocol behavior.

## Tasks

- [x] Add workspace display-path regressions (R12.A–R12.D; senior-dev)
  - AC: Root and nested workspace cwd values produce `<root>/<workspace>` for Claude- and OpenCode-shaped projects.
  - AC: Malformed and ordinary paths retain existing labels byte-for-byte.
  - AC: Canonical fields remain unchanged.
- [x] Implement workspace-aware display derivation and disambiguation (R12.A–R12.E; senior-dev)
  - AC: `/work/repo/.workspaces/alpha` and nested paths beneath it display exactly `repo/alpha`; distinct workspace `beta` displays exactly `repo/beta` before any collision fallback.
  - AC: Identical labels expand deterministically through existing fallback behavior.
  - AC: Non-workspace collision fixtures remain unchanged.
  - AC: HTTP, WebSocket, and dump fixtures change only `displayName`; cwd, project name, session ID, source, and backend identity remain byte-for-byte unchanged.
- [~] Review and validate workspace identity (code-correctness reviewer + browser/manual validation)
  - AC: Targeted/full tests, lint, and typecheck pass.
  - AC: Same-host and cross-host workspace examples remain distinct without overlap or horizontal scrolling at 320px and normal desktop width.
  - AC: API, WebSocket, and dump integration fixtures pass with the expected derived `displayName` values.
  - Automated validation: Targeted project-utils/render/server/CLI-dump suites passed 100/100; full suite passed 547/547; lint, typecheck, and both dump commands passed. Independent final correctness review found no Phase 06 or baseline-compatibility defects.
  - Scope validation: Canonical `projectName` still defines collision groups; workspace logical segments affect labels only inside those baseline groups. No state, plugin, filtering, polling, or canonical identity behavior changed.
  - Remaining: Browser/manual checks at 320px and normal desktop width for same-host and cross-host workspace cards, overlap, horizontal scrolling, `.local` composition, and dismissal compatibility.

## Files

- **src/project-utils.ts**: Lexical workspace display derivation and logical disambiguation.
- **tests/project-utils.test.ts**: Workspace path, malformed input, collision, fallback, and canonical-field tests.
- **public/js/render.js**: Effective display-name use in cross-host prefixes if required.
- **tests/render.test.ts**: Cross-host workspace display and raw identity coverage.
- **tests/server.test.ts**: HTTP/WebSocket workspace display-name propagation with canonical-field preservation.
- **tests/cli-dump.test.ts**: Dump output workspace display-name propagation with canonical-field preservation.
