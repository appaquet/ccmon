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
          nodejs = pkgs.nodejs_22;
          npmDepsHash = "sha256-aMqw3o68F5ftYFm8BK0QNwWhR7PBmM0It+ftnYqX2jU=";
          dontNpmBuild = true;

          # Node refuses to type-strip files under node_modules/. Move source
          # outside that path and rewrite the bin to invoke node on it directly.
          postInstall = ''
            mkdir -p $out/share/ccmon
            cp -r $out/lib/node_modules/ccmon/src $out/share/ccmon/src
            cp -r $out/lib/node_modules/ccmon/public $out/share/ccmon/public
            ln -s $out/lib/node_modules/ccmon/node_modules $out/share/ccmon/node_modules
            rm $out/bin/ccmon
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/ccmon \
              --add-flags "$out/share/ccmon/src/cli/main.ts" \
              --set NODE_NO_WARNINGS 1
          '';
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
