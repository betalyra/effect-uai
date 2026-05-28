# Recipes (extras)

Recipes that require external dependencies — local daemons, native binaries,
platform-specific runtimes, or anything else we don't want pulled in by a
root `pnpm install`.

Each folder here is a **standalone package**, deliberately excluded from the
workspace. Nothing in this tree is installed unless you opt in.

## Running a recipe

```sh
# from the repo root
pnpm -C recipes-extras/<name> install --ignore-workspace
./recipes-extras/<name>/node_modules/.bin/tsx recipes-extras/<name>/run.ts
```

Each recipe's `README.md` lists its specific prerequisites (e.g. running
the `msb` daemon for Microsandbox, hardware requirements, API keys).

## Why these flags

- **`--ignore-workspace`** — without it, pnpm walks up the directory tree,
  finds the monorepo's `pnpm-workspace.yaml`, and pulls the recipe's heavy
  native deps into the workspace root, defeating the isolation.
- **`tsx` invoked directly** — `pnpm start` triggers pnpm 10's
  pre-script "verify deps" check, which re-runs `install` in workspace
  mode and fails. Running `tsx` from the recipe's local `node_modules/.bin`
  bypasses pnpm entirely.

## Why separate

The recipes under [`recipes/`](../recipes/) only depend on lightweight
HTTP-only provider SDKs, so it's fine for `pnpm install` at the repo root
to pull them all. The recipes here don't have that property — they bring
in native binaries, daemons, or platform-specific tooling that most
developers shouldn't pay for unless they're actually running that recipe.

## Adding a new extras recipe

1. Create `recipes-extras/<name>/` with its own `package.json`. Use
   `link:../../packages/...` for refs to workspace packages (no
   `workspace:*` — this folder is outside the workspace).
2. **For `effect` specifically**, point at the workspace's installed copy
   via `link:../../packages/core/node_modules/effect` rather than a
   version range. Otherwise the recipe gets its own copy of `effect` and
   the linked workspace providers get the workspace's copy — two
   instances, which breaks `Redacted` and any other module-private
   `WeakMap` state.
3. Add a `README.md` documenting prerequisites and the install + run
   commands above.
4. Keep the folder out of `pnpm-workspace.yaml` (the current globs
   already exclude `recipes-extras/`).
