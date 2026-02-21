# Phase: Packaging

## Context

See [00-ccmon](00-ccmon.md). Expose ccmon as a Nix flake package and add a README.

ccmon has zero npm runtime dependencies — only `@types/bun` as devDep. Bun runs TypeScript source natively. This means packaging is a `writeShellScriptBin` wrapper, not a full `mkDerivation` build.

## Tasks

### Step 1: Update `flake.nix` to expose package

* [x] Add `packages.${system}.ccmon` using `writeShellScriptBin` (R15.1)
  * Wrapper: `exec ${pkgs.bun}/bin/bun run ${src}/src/cli.ts "$@"`
  * `src` = project root (`./.`) copied into Nix store
  * Bun pinned from nixpkgs — fully hermetic (R15.3)
* [x] Add `packages.${system}.default = packages.${system}.ccmon` (R15.2)
* [x] Add `apps.${system}.default` (R15.2)
* [x] Test: `nix build .#ccmon` succeeds
* [x] Test: `result/bin/ccmon dump` produces JSON output (9 projects)
* [x] Test: `echo '...' | result/bin/ccmon status` works (returns `{}`)

### Step 2: Write README.md

* [x] Write README with sections (R16):
  * Brief description of what ccmon does
  * Available commands (`dump`, `dump --watch`, `status`, `serve`)
  * Installation via Nix flake (flake input + home.packages)
  * Claude Code hook configuration (settings.json format, which events)
  * Development section (bun install, bun test)
* [x] Personal/dotfiles audience — concise, assumes NixOS + home-manager (R16.1)

### Step 3: Update CLAUDE.md

* [x] Add `bun run serve` and `bun run dump --watch` to CLAUDE.md (R12)

## Files

- **flake.nix**: Add packages and apps outputs
- **README.md**: Install and hook configuration guide
- **CLAUDE.md**: Updated with new commands
