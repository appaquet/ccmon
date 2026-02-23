# Phase: GitHub Actions CI

## Context

See [00-ccmon](00-ccmon.md). Add a GHA workflow that runs lint, typecheck, and tests on every push and pull request.

## Tasks

- [x] Create `.github/workflows/ci.yml` — triggers on push/PR, ubuntu-latest, setup-bun, bun install, lint, typecheck, test as separate named steps

## Files

- **.github/workflows/ci.yml**: GHA workflow — lint + typecheck + test on push and pull_request
