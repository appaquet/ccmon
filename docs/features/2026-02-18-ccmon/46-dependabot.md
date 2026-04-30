# Phase: Dependabot Setup

## Context

See [00-ccmon](00-ccmon.md). Configure Dependabot version updates for the `bun` ecosystem with a 7-day cooldown. Dependabot has supported `bun` as a first-class `package-ecosystem` since February 2025 (separated from `npm_and_yarn`).

## Tasks

- [x] Create `.github/dependabot.yml` — `bun` ecosystem, root directory, `schedule.interval: "daily"` + `cooldown.default-days: 7` (supply chain mitigation)
  - AC: YAML parses without errors
  - AC: Uses `package-ecosystem: "bun"` (supported since Feb 2025)
  - AC: `schedule.interval: "daily"` checks for updates daily
  - AC: `cooldown.default-days: 7` delays PRs until 7 days after release (supply chain attack mitigation)
  - AC: Security updates bypass the cooldown automatically
  - AC: Existing CI workflow (`ci.yml`) continues to run on all Dependabot PRs

## Files

- **.github/dependabot.yml** (create): Dependabot config — bun ecosystem, weekly schedule
