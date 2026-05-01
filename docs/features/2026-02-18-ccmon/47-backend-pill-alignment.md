# 47 Phase: Backend Pill Alignment

## Context

See [00-ccmon](00-ccmon.md).

The card header uses `justify-content: space-between` with three direct children: `.card-name`, `.badge-source` (OC/CC pill), and `.badge` (status pill). With `space-between`, the three items are distributed evenly across the header row, creating an unwanted gap between the project name and the OC/CC pill when the name is short. The user wants the OC/CC pill grouped with the status pill at the right edge:

```
[project-name (session name)] ......... OC Status ●]
```

## Tasks

- [x] Wrap `.badge-source` and `.badge` in a `<div class="card-pills">` container in the card HTML generation (R76)
  - AC: Both pills render as adjacent siblings inside a pill-group wrapper div
  - AC: Card header has exactly two direct children: `.card-name` and `.card-pills`
- [x] Add CSS for `.card-pills` — `display: flex; align-items: center; gap: 6px;`
  - AC: Pills group is right-aligned (pushed by `space-between` on parent)
  - AC: OC/CC pill sits directly to the left of the status pill with a 6px gap
  - AC: Project name remains left-aligned, truncated with ellipsis when too long
- [x] Run lint, typecheck, and verify visual layout
  - AC: `bun run lint` passes (no new violations introduced)
  - AC: `bun run typecheck` passes (HTML-only change, no TS impact)
  - AC: `bun run serve` shows cards with pills grouped at right edge

## Files

- **public/index.html**: HTML generation in `createCard()` (wrap pills in div); CSS addition for `.card-pills`
