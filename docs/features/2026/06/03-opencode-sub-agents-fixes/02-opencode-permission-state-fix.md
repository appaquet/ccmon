# OpenCode permission state fix

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase covers the second reported issue: OpenCode permission questions are not surfacing as blocked/waiting in ccmon. The work here is to normalize the permission event path so pending approval appears as `waiting_for_permission` and later resolves cleanly.

## Requirements

* R2.A: ⬜ Map the current OpenCode permission events and determine the canonical pending-approval signal for ccmon.
* R2.B: ⬜ Ensure pending OpenCode permission requests are classified as `waiting_for_permission` rather than `running`.
* R2.C: ⬜ Ensure the state returns to the correct running/stopped behavior after the request is answered or expires.

## Questions & Investigations

* [x] Q: Which OpenCode permission events should ccmon consume?
  * Uncertainty: The older `permission.ask` path appeared to be outdated for current OpenCode versions.
  * Tried: Checked current OpenCode docs and aligned the plugin handling with the generic permission event flow.
  * Result: Consume `permission.asked` and `permission.replied` as the canonical pending/replied signals.
* [x] Q: Should OpenCode permission handling invent a new blocked state?
  * Uncertainty: The product language mentions blocked/questions, while ccmon already exposes `waiting_for_permission`.
  * Tried: Compared the requested behavior with the existing state model.
  * Result: Reused `waiting_for_permission`; no new state was introduced.
* [x] Q: Does `permission.replied` clear `waiting_for_permission` immediately, even when it follows quickly after the ask?
  * Uncertainty: Review found a possible gap where normalizing replies to a generic running event may still trigger the permission resolve delay logic.
  * Tried: Compared the normalized reply event against the shared permission-resolution rules and added a fast-reply regression test.
  * Result: No at first; reply normalization was changed so explicit permission replies clear waiting state immediately.
* [x] Q: What event family does a real main-agent AskUserQuestion prompt use?
  * Uncertainty: The remaining live repro stayed `running` even after the `permission.*` fix landed.
  * Tried: Inspected the actual OpenCode runtime log and matching `opencode-status.jsonl` lines for the failing session.
  * Result: The main-agent prompt uses `question.asked`, `question.replied`, and `question.rejected`; the plugin currently ignores those events, so no `waiting_for_permission` line is emitted.
* [x] Q: Can the installed plugin copy be updated directly from this environment?
  * Uncertainty: The repo plugin fix does not help the live repro until `~/.config/opencode/plugins/ccmon.ts` is updated and reloaded.
  * Tried: Attempted to copy the fixed repo plugin into the installed plugin path.
  * Result: No — the target path is currently mounted read-only in this environment, so live deployment/retest requires user/manual sync and OpenCode reload.

## Tasks

- [x] Investigate current OpenCode permission events and ccmon’s event mapping (staff-dev) (R2.A)
  - AC: documented the live event names and the state transitions they should drive.
- [x] Implement permission-state normalization for OpenCode (senior-dev) (R2.B, R2.C)
  - AC: a pending permission request is visible as `waiting_for_permission`.
  - AC: resolved or stale permission requests no longer leave the session stuck in the pending state.
- [x] Add regression tests for ask/reply/stale permission flows (senior-dev or junior-dev) (R2.A-R2.C)
  - AC: tests fail before the fix and pass after it.
  - AC: tests cover both the pending state and the post-reply transition.
- [x] Run backend verification and state-output checks (senior-dev) (R2.B-R2.C)
  - AC: targeted OpenCode tests pass.
  - AC: ccmon output reflects the intended waiting state while a question is pending.
- [x] Make `permission.replied` resolve pending permission state immediately if the review finding is confirmed (senior-dev) (R2.B, R2.C)
  - AC: a replied permission request no longer remains `waiting_for_permission` because of the generic permission resolve gap.
- [x] Investigate the failing main-agent AskUserQuestion repro against live logs (staff-dev) (R2.A)
  - AC: identifies the exact emitted event names, session id, and whether `opencode-status.jsonl` received a waiting-state line.
- [x] Add `question.*` event handling for main-agent prompts (senior-dev) (R2.A-R2.C)
  - AC: `question.asked` writes a waiting-state event for the main OpenCode session.
  - AC: `question.replied` and `question.rejected` clear the waiting state immediately.
  - AC: a real main-agent Question tool prompt no longer leaves ccmon showing `running` during the pending window.
- [x] Add regression coverage for `question.asked` / `question.replied` / `question.rejected` (senior-dev or junior-dev) (R2.A-R2.C)
  - AC: tests fail before the fix and pass after it.
  - AC: tests prove the question-tool path is distinct from, but aligned with, the permission-tool path.
- [~] Sync the updated plugin copy into the live OpenCode config and re-verify the main-agent repro (senior-dev, may need user restart/retest) (R2.A-R2.C)
  - AC: `~/.config/opencode/plugins/ccmon.ts` contains the `question.*` mapping.
  - AC: after plugin reload/restart, a real main-agent Question tool prompt produces `waiting_for_permission` in ccmon during the pending window.

## Files

- **src/backends/opencode.ts**: OpenCode state resolution path that needs the permission-state fix. Changes: permission events are normalized through shared waiting/running resolution behavior, and explicit replies clear waiting state immediately.
- **resources/opencode-plugin/ccmon.ts**: Permission-event writer that may need event-name alignment. Changes: listens to `permission.asked` / `permission.replied` and now `question.asked` / `question.replied` / `question.rejected`, with replies recorded as immediate resolver events.
- **~/.config/opencode/plugins/ccmon.ts**: Installed plugin copy used by live OpenCode sessions. Pending manual sync because this environment could not write the file.
- **~/.local/share/opencode/log/**: Live OpenCode runtime logs used to identify `question.*` as the real event family for the failing repro.
- **~/.local/state/ccmon/opencode-status.jsonl**: Live status log used to confirm the failing prompt never wrote a waiting-state line.
- **src/session-core.ts**: Reference behavior for permission / waiting-state resolution.
- **tests/backends/opencode.test.ts**: Backend regression coverage for permission state. Changes: asked/replied/stale permission flows covered, including fast replies inside the permission resolve gap and the main-agent `question.*` path.
- **tests/session-core.test.ts**: Permission-state reference behavior and timing rules.
