{
  description = "ccmon - Claude Code & OpenCode Monitor";

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
          NODE_PATH="${src}/node_modules" exec ${pkgs.nodejs_22}/bin/node --import tsx/esm ${src}/src/cli.ts "$@"
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
          buildInputs = [ pkgs.nodejs_22 ];
        };
      }
    );
}
