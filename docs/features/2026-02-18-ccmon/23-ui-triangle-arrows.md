# Phase: UI Triangle Arrows

## Context

See [00-ccmon](00-ccmon.md). Replace ASCII `>` and `<` indicators for user/assistant messages in dashboard cards with UTF-8 solid triangles (`▶` / `◀`) for cleaner appearance.

## Tasks

- [ ] Replace `&gt;` with `▶` (U+25B6) in `renderAgentRow()` for user messages (line ~588)
- [ ] Replace `&lt;` with `◀` (U+25C0) in `renderAgentRow()` for assistant messages (line ~594)
- [ ] Visual verification: run `bun run serve`, confirm triangles render correctly in dashboard cards

## Files

- **public/index.html**: `renderAgentRow()` — two HTML entity replacements
