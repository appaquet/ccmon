{
  description = "ccmon - Claude Code Monitor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        src = ./.;
        ccmon = pkgs.writeShellScriptBin "ccmon" ''
          exec ${pkgs.bun}/bin/bun run ${src}/src/cli.ts "$@"
        '';
      in
      {
        packages = {
          ccmon = ccmon;
          default = ccmon;
        };

        apps.default = {
          type = "app";
          program = "${ccmon}/bin/ccmon";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.bun ];
        };
      }
    );
}
