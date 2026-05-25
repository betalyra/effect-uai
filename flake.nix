{
  description = "effect-uai — low-level primitives for AI agents in Effect";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Systems we provide a devShell for: the standard set flakes expose.
      forAllSystems = f:
        nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed
          (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Toolchain mirrors CI (.github/workflows/ci.yml): Node 24 + pnpm.
          # pnpm is pinned to the version in package.json's `packageManager`
          # field via corepack (see shellHook), so it always matches CI exactly.
          packages = [
            pkgs.nodejs_24
            pkgs.corepack       # provides the pnpm version pinned in package.json
            pkgs.deno           # only needed for the deno integration-test suite
            pkgs.git
          ];

          shellHook = ''
            # Activate the pnpm version pinned in package.json without writing
            # to the read-only Nix store: keep corepack's shims under the repo.
            export COREPACK_HOME="$PWD/.corepack"
            export PATH="$COREPACK_HOME/bin:$PATH"
            mkdir -p "$COREPACK_HOME/bin"
            corepack enable --install-directory "$COREPACK_HOME/bin" pnpm >/dev/null 2>&1 || true

            echo "effect-uai dev shell"
            echo "  node $(node --version)"
            echo "  pnpm $(pnpm --version 2>/dev/null || echo '(run: corepack prepare --activate)')"
            echo "  deno $(deno --version | head -n1 | cut -d' ' -f2)"
          '';
        };
      });
    };
}
