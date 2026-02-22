# Phase 10: UI Polish

## Context

See [00-ccmon](00-ccmon.md). A collection of UI improvements and small data model fixes identified from real-world usage.

## Questions

* Q1: ✅ How are slash commands detected in JSONL? → User messages where `message.content` is a string containing `<command-name>` XML tags. Currently filtered OUT by the `!content.startsWith('<')` check in `readSessionTail()`. Need a parallel scan to extract them.
* Q2: ✅ Token inaccuracy root cause? → Current code only sums `input_tokens` (non-cached marginal portion, ~244 tokens). Provider-billed total = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (~11M tokens). Should sum all three.
* Q3: ✅ Where does `lastMessageTime` come from for sub-agents? → File mtime from the `stat()` call already in `getSubagentInfos()`. Cheap to include.
* Q4: ✅ Backend vs UI filtering for completed agents? → Backend filters `!isActive && mtime > 5m`. UI hides `!isActive && lastMessageTime > 2m`. Two-tier: backend reduces payload size, UI provides grace period.

## Tasks

### R37 — Latest command/skill display

- [x] Add `latestCommand?: string` to `SessionEnrichment` in `sessions.ts` (R37)
- [x] In `readSessionTail()`, detect user string content containing `<command-name>`; extract command name + args into `latestCommand`; track scan ordering so the most recent user entry (command or message) determines what UI shows (R37)
- [x] In `index.html`, display `latestCommand` or `latestUserMessage` — whichever is more recent (R37)
- [x] Add test: `latestCommand` extracted from `<command-name>` user entries (R37)
- [x] Add test: when command is more recent than message, UI field shows command; vice versa (R37)

### R38 — Sub-agent: last activity only (not both)

- [x] In `index.html` sub-agent rendering, show `lastToolUse` if available, else `latestAssistantMessage` — never both (R38)

### R39 — Token accuracy: provider-billed input total

- [x] In `readSessionTail()`, sum `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` for `inputTokens` (R39)
- [x] Update token accumulation tests to expect provider-billed total (R39)

### R40 — Sub-agent lifecycle: auto-hide and expiry

- [x] Add `lastMessageTime: string` (ISO 8601) to `SubagentInfo`; populate from file mtime in `getSubagentInfos()` (R40)
- [x] In `getSubagentInfos()`, filter out agents where `!isActive && mtime > 5 minutes` (R40)
- [x] In `index.html`, hide agents where `!isActive && lastMessageTime > 2 minutes old` (R40)
- [x] Add test: `lastMessageTime` populated on `SubagentInfo` (R40)
- [x] Add test: completed agent excluded from backend payload after 5m (R40)

### R41 — Keep enrichment info visible when stopped

- [x] In `index.html`, when session transitions to stopped, preserve enrichment fields (messages, tokens, tasks, tool use) — only update the state pill/indicator (R41)
- [x] Clear fields that don't make sense in stopped state if any (R41) — confirmed no clearing needed, fields already preserved

### R42 — Sub-agent status indicator

- [x] In `index.html`, show a filled checkmark dot (✓) for completed (`!isActive`) sub-agents instead of an active dot (R42)

### R43 — Sub-agents ordered by launch time desc

- [x] Add `launchTime: string` (ISO 8601) to `SubagentInfo`; populate from first JSONL line timestamp or file mtime in `getSubagentInfos()` (R43)
- [x] Sort sub-agents descending by `launchTime` in `getSubagentInfos()` or in the server state map (R43)

### R44 — Show sub-agent model in UI

- [x] In `index.html` sub-agent rows, display the `model` field (short name: Opus/Sonnet/Haiku) from `SessionEnrichment` (R44)

## Files

- **src/sessions.ts**: Added `latestCommand` to `SessionEnrichment`; token fix (input+cache_creation+cache_read); `lastMessageTime`/`launchTime` on `SubagentInfo`; 5m expiry filter; descending sort by launchTime
- **public/index.html**: R37 command display (`/ ` prefix); R38 one activity (lastToolUse??assistant); R40 2m UI hide; R42 checkmark CSS for done agents; R44 model in sub-agent rows
- **tests/sessions.test.ts**: +16 tests for R37 command extraction/ordering, R39 token totals, R40 lifecycle/expiry, R43 ordering (128 → 144)
