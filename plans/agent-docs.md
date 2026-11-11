# Agent docs in the package

Status: proposed (2026-11-10). Nothing implemented yet.

Goal: an agent working in a project on any effect-uai version reads docs and
recipes that match the installed version, from
`node_modules/@effect-uai/core/agent-docs/`. Today the skill
(`npx skills add betalyra/effect-uai`) and effect-uai.com both describe
`main`, so users pinned to an older version get wrong APIs.

Prior art: Next.js 16.2 ships its docs in `next/dist/docs/` plus an
`AGENTS.md` pointer (Vercel's evals: 100% vs up to 79% for skills); TanStack
Intent, `skills-npm` and `npx skills experimental_sync` discover
`<pkg>/skills/<name>/SKILL.md` in `node_modules`.

## Package layout

Generated at `prepack` (runs for both `pnpm release` and the `@dev` snapshot),
gitignored, added to core's `files`:

```
packages/core/
  agent-docs/
    INDEX.md                  # one line per page: file path, site path, title, description
    docs/**/*.{md,mdx}        # from root docs/, minus index.mdx and intro.mdx
    recipes/<name>/README.md  # from recipes/ and recipes-extras/ (merged, like the site)
    recipes/<name>/*.ts       # recipe code, no node_modules / example output
  skills/effect-uai/SKILL.md  # copy of skills/effect-uai/SKILL.md
```

## Steps

1. **`scripts/pack-agent-docs.ts`** (root dev deps: `unified`, `remark-parse`,
   `remark-mdx`, `remark-gfm`). For each source file:
   - Parse to an AST only to collect `link` / `definition` node URLs and their
     positions. Splice the rewritten URLs into the original text; never
     stringify the AST (it would reformat every file).
   - Rewrite site paths (`/recipes/voice-loop/`, `/language-models/loop#x`) to
     relative file paths, using the inverse of `generateId` in
     `webpage/src/content.config.ts`. Keep anchors. Leave external URLs alone.
     Unresolvable site paths fail the script (catches dead links too).
   - In `.mdx`, drop `mdxjsEsm` import nodes (`import Callout ...`). Components
     stay as-is; models read `<Callout title>` fine.
   - Build `INDEX.md` from frontmatter `title` / `description`.
2. **Core `package.json`**: `"prepack": "tsx ../../scripts/pack-agent-docs.ts"`
   (or whatever runner the repo settles on), add `"agent-docs"` and `"skills"`
   to `files`.
3. **Skill**: replace "fetch the recipe's page from the docs site" and the
   `effect-uai.com/recipes/<name>/` pointer with: read
   `node_modules/@effect-uai/core/agent-docs/INDEX.md` first (version-matched),
   fall back to effect-uai.com only if missing.
4. **Docs** (`docs/skills.md`): an `AGENTS.md` / `CLAUDE.md` snippet users
   paste in, and a note that `npx skills add` installs the latest skill while
   the packaged copy matches the installed version.
5. **CI guard** (`release.yml`): `pnpm pack --dry-run` in `packages/core`,
   fail if `agent-docs/INDEX.md` or `skills/effect-uai/SKILL.md` is missing.

## Open questions

- Recipe files to include: `README.md` + `*.ts` only, or also `package.json`
  (shows which provider packages a recipe needs)? Exclude `example/` media.
- Tarball size: docs ~740K + recipe md/ts ~1.5M unpacked. Check the packed
  size before and after.
- Intent compatibility: check whether `@tanstack/intent install` needs a
  `package.json` field beyond the `skills/` folder.
