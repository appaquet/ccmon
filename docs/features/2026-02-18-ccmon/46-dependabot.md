# Phase: Dependabot Setup

## Context

See [00-ccmon](00-ccmon.md). Configure Dependabot version updates for the `bun` ecosystem with a 7-day cooldown. Dependabot has supported `bun` as a first-class `package-ecosystem` since February 2025 (separated from `npm_and_yarn`).

## Tasks

- [ ] Create `.github/dependabot.yml` — `bun` ecosystem, root directory, `schedule.interval: "weekly"` (7-day cooldown)
  - AC: YAML parses without errors
  - AC: Uses `package-ecosystem: "bun"` (supported since Feb 2025)
  - AC: `schedule.interval: "weekly"` ensures PRs are opened at most once per 7 days
  - AC: Existing CI workflow (`ci.yml`) continues to run on all Dependabot PRs
  - AC: After merge, repo's Dependabot dashboard shows the config active

## Files

- **.github/dependabot.yml** (create): Dependabot config — bun ecosystem, weekly schedule
