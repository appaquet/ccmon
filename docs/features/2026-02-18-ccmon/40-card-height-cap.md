# Phase: Card Height Cap

## Context

See [00-ccmon](00-ccmon.md). Cards with many sub-agents (10+) consume the entire dashboard viewport height. Add max-height with overflow hidden on the agents section so header and context bar remain visible.

## Tasks

- [x] Add `.card-agents` CSS class with `max-height: 300px; overflow: hidden` (R66)
- [x] Wrap agent rows (main + sub-agents) in a `div.card-agents` container in `createCard()` (R66)
- [x] Run lint + typecheck to verify no regressions

## Files

- **public/index.html**: Add `.card-agents` CSS rule (`max-height: 300px; overflow: hidden`); wrap agent rows (main + sub-agents) in `div.card-agents` container in `createCard()`
