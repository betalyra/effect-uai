# Dev builds: `@dev` snapshots on npm

Status: proposed (2026-11-09). Nothing implemented yet.

Goal: anyone can try what is on `dev` with `pnpm add @effect-uai/core@dev`,
without a version bump in git and without touching `latest`.

PR previews via pkg.pr.new are a follow-up (see end).

## How it works with changesets

A changesets **snapshot release**. It is a version rewrite that only exists
inside the CI job; nothing is committed, tagged or pushed.

```sh
pnpm changeset version --snapshot dev   # rewrites package.json versions + CHANGELOGs in the CI checkout
pnpm build
pnpm changeset publish --tag dev --no-git-tag
```

- **Version**: with `snapshot.useCalculatedVersion: true` the version is the
  next release plus a prerelease suffix, e.g. `0.18.0-dev-20261109143012`
  (current is 0.17.0, pending changesets say minor). It tells you which release
  it precedes, and a prerelease never collides with the real `0.18.0`.
- **Dist-tag**: `--tag dev` moves only the `dev` tag. `latest` stays on the
  last stable release, and `^0.17.0` ranges never resolve to a prerelease, so
  existing users are unaffected.
- **Fixed group**: one pending changeset bumps the whole group, so all 27
  packages get the same snapshot version. Internal deps are pinned to that exact
  snapshot version, so `@effect-uai/openai@dev` pulls the matching
  `@effect-uai/core`.
- **No changesets, no snapshot**: if `.changeset/` has no pending entries,
  `changeset version --snapshot` does nothing. The job should detect that and
  skip (dev with no changesets is identical to `latest` anyway).
- **Private/ignored**: `@effect-uai/recipes` and `@effect-uai/recipe-kit` stay
  out, same as stable.
- **Changelog**: we use `@changesets/cli/changelog`, which needs no GitHub
  token (the `@changesets/changelog-github` token gotcha does not apply).

Rejected: `changeset pre enter dev`. Pre mode commits prerelease versions and a
`pre.json` to the branch, which then conflicts with every `dev` to `main` merge
and with the release PR.

## Workflow placement

npm trusted publishing (OIDC) is configured per package for
`betalyra/effect-uai` + `release.yml`. A dev job in a new workflow file would
need 27 trusted-publisher entries re-done on npmjs.com, so the job goes **into
`release.yml`** as a second job:

```yaml
on:
  push:
    branches: [main, dev]
  schedule:
    - cron: "0 3 * * *"        # optional nightly
  workflow_dispatch:

jobs:
  release:                      # existing stable job, unchanged
    if: github.ref == 'refs/heads/main' && github.event_name != 'schedule'
    ...

  dev-snapshot:
    if: github.ref == 'refs/heads/dev' || github.event_name == 'schedule'
    permissions:
      contents: read
      id-token: write
    steps:
      - checkout (ref: dev)
      - pnpm/setup-node (registry-url npmjs), npm >= 11.5.1
      - pnpm install --frozen-lockfile
      - skip if no pending changesets
      - pnpm changeset version --snapshot dev
      - pnpm build && pnpm typecheck && pnpm test
      - pnpm changeset publish --tag dev --no-git-tag
```

`.changeset/config.json` gets:

```json
"snapshot": { "useCalculatedVersion": true, "prereleaseTemplate": "{tag}-{datetime}" }
```

The `tag-and-release.sh` step stays in the stable job only.

## Open decisions

1. **Trigger**: every push to `dev` (fresh, but 27 npm versions per push),
   nightly-if-changed (recommended default), or manual dispatch only.
2. **Gate on CI**: run tests in the snapshot job itself (simple, duplicate
   work) or `workflow_run` after `CI` succeeds (no duplication, but
   `workflow_run` runs the workflow file from the default branch).
3. **Tag name**: `dev` (matches the branch) vs `next` / `canary` (convention
   elsewhere). `dev` is clearest here.

## Risks / checks before implementing

- `npm install -g npm@latest` in release.yml: npm 12 reportedly returns an
  array from `npm info --json`, which breaks changesets. Pin `npm@11` in both
  jobs if 12 is current.
- Verify on npmjs.com that the trusted publisher entries don't restrict to a
  GitHub environment or branch that would block runs from `dev`.
- First run: `workflow_dispatch --ref dev` and check one package with
  `npm view @effect-uai/core dist-tags`.
- npm version clutter is permanent (snapshot versions can't be removed after
  72h). Nightly-if-changed keeps it bounded.

## New packages: trusted publisher bootstrap

The dev job alone doesn't solve the first publish: OIDC can't create a
package, and `npm trust` docs state the package "must already exist on the npm
registry". A brand-new `@effect-uai/*` package fails the dev job with E404 just
like the stable job.

What does change: since npm 11.15.0 the trusted publisher can be set from the
CLI (`npm trust github`), no more npmjs.com UI. So a local, one-off bootstrap
script per new package:

```sh
# scripts/npm-bootstrap.sh @effect-uai/<new>   (run locally, 2FA prompt)
# 1. publish a placeholder (0.0.0, --tag dev, --access public) from a temp dir
# 2. npm trust github @effect-uai/<new> --repo betalyra/effect-uai \
#      --file release.yml --allow-publish --yes
```

Then push to `dev`: the dev job publishes the first real snapshot via OIDC,
which proves the trusted publisher works before the stable release runs.

To verify: whether the first publish with `--tag dev` still sets `latest` to
the placeholder (the registry may add `latest` when none exists; npm won't let
you remove `latest`). Harmless either way: the stable release moves it.

## Follow-up: PR previews via pkg.pr.new

- Install the pkg.pr.new GitHub App; add a `preview` job to `ci.yml`:
  `pnpx pkg-pr-new publish --pnpm --comment=update './packages/**'`,
  `permissions: {}`, no secrets.
- Same-repo PRs only (`head.repo.full_name == github.repository`). Approval
  gating is not a real boundary: any PR whose CI runs can call the publish
  endpoint, so forks must not run it at all.
