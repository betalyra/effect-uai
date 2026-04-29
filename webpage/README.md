# webpage

Astro + Starlight site for `effect-uai`. Reads its docs directly from the
top-level [`docs/`](../docs) folder via the content collection's `glob`
loader — no copy step.

## Develop

```sh
pnpm install        # from repo root
pnpm docs:dev       # or: pnpm --filter webpage dev
```

## Build

```sh
pnpm docs:build
```

Build output goes to `webpage/dist/` (gitignored).
