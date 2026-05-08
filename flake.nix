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

        ccmon = pkgs.buildNpmPackage {
          name = "ccmon";
          src = ./.;
          npmDepsHash = "sha256-HRd4ArTKST3/tvttF/bFwn6rTwRfuFM95+tf7OX63AA=";
          makeWrapperArgs = [
            "--set"
            "NODE_NO_WARNINGS"
            "1"
          ];
        };

        opencodePlugin = pkgs.runCommand "ccmon-opencode-plugin" { } ''
          mkdir -p $out
          cp ${./resources/opencode-plugin/ccmon.ts} $out/ccmon.ts
        '';
      in
      {
        packages = {
          inherit ccmon;
          default = ccmon;
          opencode-plugin = opencodePlugin;
        };

        apps = {
          default = {
            type = "app";
            program = "${ccmon}/bin/ccmon";
          };

          ccmon = {
            type = "app";
            program = "${ccmon}/bin/ccmon";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs_22 ];
        };
      }
    );
}
