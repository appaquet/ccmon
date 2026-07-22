# Phase 01: Session Card Layout

## Context

The current dashboard card combines the project name and OpenCode session name as `projectName (sessionName)`. Long combined values are hard to scan and can obscure which session is active. The completed direction is a compact two-row identity block with a wider card cap, validated by the user in the dashboard.

## Requirements

* R1.A: ✅ Show the available session name as the card's primary identity rather than as parenthesized text after the project name.
* R1.B: ✅ Omit the session row when no human-readable session name is available.
* R2.A: ✅ Show the project name on a distinct first-row context line from the session name.
* R3.A: ✅ Show the server hostname on the first-row context line for every card.
* R4.A: ✅ Keep textual state, backend, context, task, agent, and flash information available without displacing the identity hierarchy.
* R5.A: ✅ Implement the reviewed ASCII wireframe with single-line ellipsis and a narrow-screen-safe card width increase.

## Design

### Reviewed ASCII layout

```text
┌────────────────────────────────────────────────────────┐
│ ● Running   project-name                  machine-name   │
│ session-name-that-keeps-the...                         │
├────────────────────────────────────────────────────────┤
│ 💭 [██████░░] 80k                         📋 12/15      │
│                                                        │
│ ● Main agent                                  Sonnet   │
│   > latest user activity                               │
│   < latest assistant/tool activity                     │
│                                                        │
│ ● Sub: <description>                            Opus   │
│   > initial instruction                                │
└────────────────────────────────────────────────────────┘
```

The intended hierarchy is:

1. The first row contains the existing textual state pill, project display name, and right-aligned server hostname in that order; separators and the source badge are intentionally omitted.
2. The second row contains the human-readable session name and receives the strongest visual emphasis; it is omitted if no name exists.
3. Values stay on one line with the existing ellipsis behavior and full-value title/DOM affordance.
4. The card maximum widens to approximately 480px while the grid remains safe on narrow screens.
5. Existing context, task, agent, and flash behavior remains unchanged.

This is the completed implementation direction. The textual state pill retains its current semantics; the source badge and separators are intentionally omitted.

## Questions & Investigations

* [x] Q: What existing UI decision created the current problem?
  * The earlier session-name phase intentionally rendered `projectName (sessionName)` in the card header. This phase revisits the hierarchy now that the combined value is difficult to scan.
* [x] Q: Which frontend symbols are relevant to a later implementation?
  * `createCard()` in `public/js/render.js` builds the card.
  * `sessionIdentityLabel()` and `getSortedProjects()` are existing identity/sorting helpers tested in `tests/render.test.ts`.
  * Host information arrives through the server WebSocket envelope and is merged by `public/js/backend-manager.js`.
* [x] Q: What broad layout principles should constrain iteration?
  * Keep one primary identity, separate metadata into distinct rows, avoid fixed-height clipping of identity text, and ensure flex children can shrink before ellipsis is applied.
* [x] Q: Should the labels be literal `Session`, `Project`, and `Machine`, or should the visual treatment make the values self-evident?
  * Use compact unlabeled values in the visual layout; preserve semantic/title context in the DOM.
* [x] Q: When there is no session name, should the project value occupy the primary line or should the `Session` line be omitted?
  * Omit the second row when no human-readable session name exists.
* [x] Q: Should long values wrap, ellipsize, or expose the complete value through a tooltip/accessible name?
  * Continue single-line ellipsis and retain full-value title/DOM access.
* [x] Q: Is the host always the server hostname, or can the card need a project-specific machine value?
  * Use the server hostname and show it on every card.
* [x] Q: Should the card remain capped at 360px?
  * No. Widen the maximum to approximately 480px while retaining a narrow-screen-safe minimum.
* [x] Q: How should the frontend preserve project disambiguation across hosts?
  * Keep the explicit per-render cross-host display name as the highest-priority identity override, then use the server-provided display name, then the raw project name.
* [x] Q: Where should the existing WebSocket hostname be attached for card rendering?
  * Propagate it as a frontend-only field on each cloned project in `BackendManager`; no backend payload schema change is required.
* [x] Q: How should the first identity row be ordered after visual validation?
  * Use `state   project-name                         machine`; omit separators and the source badge.
* [x] Q: Why did the first implementation look visually incoherent in the browser?
  * A flex hostname reservation consumed space while the project began at zero flex basis, so project names collapsed into fragments or disappeared. Replace that arrangement with independent grid tracks that give project and hostname a fair 3:2 share while allowing both to ellipsize.
* [x] Q: Is the backend source badge useful in the final identity row?
  * No. The user considers `OC`/`CC` redundant; remove it and keep state, project, hostname, and session identity.

## Tasks

- [x] Record the current identity problem and information hierarchy (R1–R4)
  - AC: The current parenthesized presentation, session-first priority, separate project line, and separate machine line are documented.
  - AC: The approved two-row identity hierarchy is captured.
- [x] Draft and review the ASCII card layout (R5)
  - AC: The wireframe shows project/machine/source/state on row one and session on row two.
  - AC: The wireframe retains state/backend indicators and the existing context/agent area at a high level.
- [x] Review and iterate on the ASCII proposal with the user (R1–R5)
  - AC: User feedback is captured as the reviewed two-row layout and resolved questions above.
- [x] Implement the identity block and hostname propagation (R1–R4)
  - AC: A named session is rendered as a distinct second row without parentheses.
  - AC: A missing or whitespace-only human-readable session omits the second row.
  - AC: The first row orders textual state, project, and right-aligned server hostname with no separator or source badge.
  - AC: Existing context, task, main-agent, sub-agent, and flash behavior is preserved.
- [x] Widen the card grid safely (R3–R5)
  - AC: The card maximum is approximately 480px on wider layouts.
  - AC: Narrow viewports do not introduce horizontal overflow.
  - AC: Identity values retain single-line ellipsis and full-value title/DOM access.
- [x] Correct the identity-row sizing after visual validation (R2–R5)
  - AC: Project and hostname are distinct fields with independent shrink-safe grid tracks.
  - AC: A long hostname cannot consume the entire project field.
  - AC: Regression coverage distinguishes project name from server hostname.
- [x] Add focused automated coverage (R1–R5)
  - AC: Tests cover named and missing-session identity rendering/data, hostname propagation, source/state visibility, and preserved card content.
  - AC: Tests cover cross-host display-name precedence and whitespace-only session names.
  - AC: Existing test, lint, and typecheck commands pass (443 tests, lint clean, typecheck clean).
- [x] Validate the result manually with the user (R1–R5)
  - AC: User checks long values, missing session names, multiple hosts, every state/source badge, narrow and wide cards, and preserved context/agent content.
  - AC: User feedback is captured: remove the source badge and the status/project separator; preserve independent project/hostname sizing.
- [x] Remove the redundant source badge after validation (R4–R5)
  - AC: No `OC`/`CC` badge is rendered in the identity row.
  - AC: State, project, hostname, session, and lower card content remain visible and tested.

## Files

- **public/js/render.js**: Two-row card identity rendering and explicit display-name precedence.
- **public/index.html**: Card identity styles, ellipsis rules, and approximately 480px grid cap.
- **public/js/utils.js**: Existing escaping/truncation helpers retained by the card.
- **public/js/backend-manager.js**: Frontend host/backend merge context and per-card hostname propagation.
- **src/server.ts**: WebSocket hostname envelope.
- **src/types.ts**: Session, project, source, and state fields used by cards.
- **tests/render.test.ts**: Focused identity, hostname, fallback, cross-host, and preserved-card assertions.
