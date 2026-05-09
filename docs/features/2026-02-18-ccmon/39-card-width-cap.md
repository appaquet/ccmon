# Card Width Cap

## Context

See [00-ccmon](00-ccmon.md). Cards stretch to fill full viewport width via `1fr` grid max. Cap card width at 360px and center the grid so cards stay compact and more fit per row.

## Tasks

- [x] Change `grid-template-columns` from `repeat(auto-fill, minmax(260px, 1fr))` to `repeat(auto-fill, minmax(260px, 360px))` in `#project-grid` (R65)
- [x] Add `justify-content: center` to `#project-grid` so remaining space is distributed evenly (R65)
- [x] User validates visually in browser (R65)

## Files

- **public/index.html**: Grid CSS changes
