# Releasing

Every public package ships at the same version, always. `@effect-uai/core`
0.14.0 means `@effect-uai/fal` 0.14.0 and every other package too, whether or
not that package changed. Two things enforce it: the `fixed` group in
[`.changeset/config.json`](.changeset/config.json), and
[`scripts/tag-and-release.sh`](scripts/tag-and-release.sh), which reads the
canonical version from `packages/core/package.json`, compares it against every
non-private package, and fails the release loudly on drift.

Publishing happens in GitHub Actions via npm trusted publishing (OIDC). There is
no `NPM_TOKEN` and no OTP in the normal path.

## Routine release

1. Land the work on `dev`. Each user-visible change gets a changeset:

   ```sh
   pnpm changeset
   ```

   Pick only the packages the change actually describes. The `fixed` group
   bumps everything else regardless, so the package list controls which
   CHANGELOGs the text lands in, not which packages ship.

2. PR `dev` into `main` and merge it.

3. [`release.yml`](.github/workflows/release.yml) runs on the push to `main`,
   sees pending changesets, and opens or updates a **`chore: release`** PR. That
   PR is `changeset version`: it bumps every package, rewrites the CHANGELOGs,
   and deletes the consumed changeset files.

   Do not run `changeset version` locally. It is not a dry run and it consumes
   the changesets on disk.

4. Review the release PR, mainly the CHANGELOG text, and merge it.

5. `release.yml` runs again. With no changesets left it takes the publish path:
   `pnpm release` (build, then `changeset publish`), followed by
   `scripts/tag-and-release.sh`, which creates the single `v<version>` tag and
   one combined GitHub Release whose body concatenates each package's section
   for that version.

6. Back-merge `main` into `dev`.

## Adding a new package

A new package needs six things done before the routine release above will work.
The reason for the manual publish in step 5 is that npm trusted publishing is
configured per package in the npm web UI, and you cannot configure it for a
package that does not exist yet.

1. **Add it to the `fixed` group** in [`.changeset/config.json`](.changeset/config.json).

   Skipping this is the mistake that costs the most time. Changesets will
   version the package independently, it drifts off the shared version, and
   `tag-and-release.sh` then fails the whole release on the drift check. Confirm
   with `pnpm changeset status`: the new package must appear in the bump list
   alongside everything else.

2. **Set the `peerDependencies` floor to the version the package debuts at**,
   not to whatever the oldest compatible core is. Each package keeps the floor
   it debuted with and never bumps it afterwards, so the ranges in the repo read
   as a history of when each package landed.

3. **Check the package metadata**: no `private: true`, `publishConfig.access` is
   `public`, `files` lists `dist`, `src`, `README.md`, `LICENSE`, and the
   `README.md` and `LICENSE` files actually exist on disk. A `build` script is
   required, since `pnpm build` filters on `@effect-uai/*`.

4. **Write a changeset for it** so its first CHANGELOG entry is not empty.

5. **Bootstrap publish to claim the name on npm:**

   ```sh
   pnpm --filter @effect-uai/<name> build
   pnpm --filter @effect-uai/<name> publish --access public --no-git-checks --otp <code>
   ```

6. **Configure trusted publishing for the new package on npmjs.com.**

   Skipping this fails the next release, and only for that one package: the
   other 21 authenticate over OIDC and publish, and the new one errors out with
   no credentials.

Then run the routine release. `changeset publish` skips versions already on npm,
so the bootstrap version does not interfere.

### The bootstrap version is usually broken

The bootstrap publishes at the *current* version, which is the one already
released. If the new package depends on core APIs that landed after that release
and are still sitting in unconsumed changesets, those APIs are not in the
published core, and the bootstrap version cannot work.

That is expected and the window is short. Setting the peer floor correctly (step
2) makes it fail honestly: the peer range resolves to nothing and the user gets
an unmet-peer warning at install rather than a module-not-found at import.

Deprecate it once the real version is live:

```sh
npm deprecate @effect-uai/<name>@<bootstrap-version> "Bootstrap release. Use <real-version> or later."
```

`npm unpublish` also works but only within 72 hours of publishing. Deprecating
has no deadline.

## Gotchas

**`Package X must depend on the current version of @effect-uai/core`** during a
new-package release is a warning, not an error. The check asks whether core's
current version satisfies the peer range, and a floor pointing at the version
being released will not satisfy it until the bump lands. `changeset version` and
`changeset status` both complete normally, and the warning disappears after the
release PR bumps core.

**Providers compile and run against core's `dist`.** After changing core, a
provider's typecheck can pass while its runtime still uses the old build. Run
`pnpm --filter @effect-uai/core build` before testing a provider against a core
change.

## Recovery

All three are idempotent and safe to re-run.

| Situation                                        | Action                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Publish partially completed                      | Re-run `release.yml` via `workflow_dispatch`; `changeset publish` skips what is already on npm |
| OIDC publish failed and you need to ship now     | [`release-manual.yml`](.github/workflows/release-manual.yml), which takes an OTP and uses `NPM_TOKEN` |
| Published fine but the tag or Release is missing | [`tag-and-release.yml`](.github/workflows/tag-and-release.yml)                   |
