# Phase: Packaging

## Context

See [00-ccmon](00-ccmon.md). Expose ccmon as a Nix flake package and add a README.

ccmon has zero npm runtime dependencies — only `@types/bun` as devDep. Bun runs TypeScript source natively. This means packaging is a `writeShellScriptBin` wrapper, not a full `mkDerivation` build.

## Tasks

### Step 1: Update `flake.nix` to expose package

* [ ] Add `packages.${system}.ccmon` using `writeShellScriptBin` (R15.1)
  * Wrapper: `exec ${pkgs.bun}/bin/bun run ${src}/src/cli.ts "$@"`
  * `src` = project root (`./.`) copied into Nix store
  * Bun pinned from nixpkgs — fully hermetic (R15.3)
* [ ] Add `packages.${system}.default = packages.${system}.ccmon` (R15.2)
* [ ] Add `apps.${system}.default` via `flake-utils.lib.mkApp` (R15.2)
* [ ] Test: `nix build .#ccmon` succeeds
* [ ] Test: `result/bin/ccmon dump` produces JSON output
* [ ] Test: `echo '{"session_id":"s1","cwd":"/tmp","hook_event_name":"Stop"}' | result/bin/ccmon status` works

### Step 2: Write README.md

* [ ] Write README with sections (R16):
  * Brief description of what ccmon does
  * Available commands (`dump`, `dump --watch`, `status`, `serve`)
  * Installation via Nix flake (flake input + home.packages)
  * Claude Code hook configuration (settings.json format, which events)
  * Development section (bun install, bun test)
* [ ] Personal/dotfiles audience — concise, assumes NixOS + home-manager (R16.1)

### Step 3: Update CLAUDE.md

* [ ] Add `bun run serve` and hook setup notes to CLAUDE.md (R12)

## Files

- **flake.nix**: Add packages and apps outputs
- **README.md**: Install and hook configuration guide
- **CLAUDE.md**: Updated with new commands
