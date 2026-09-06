# @effect-uai/recipe-kit

Runtime and CLI plumbing shared by the runnable recipes in
[`recipes/`](../../recipes) and [`recipes-extras/`](../../recipes-extras).
Private to this repository: it is not published, and nothing in
`packages/` depends on it.

| Module         | What it does                                                                |
| -------------- | --------------------------------------------------------------------------- |
| `runtime`      | `runRecipe` / `serveRecipe`: one `run.ts` per recipe, on Node, Bun and Deno |
| `argv`         | `--flag` parsing: `flagValue`, `choiceFlag`, `providerChoice`, `intFlag`    |
| `output`       | `runDir` (timestamped, per run) and `cacheDir` (stable, read back)          |
| `render`       | The shared console renderer for agent-loop recipes                          |
| `bundle`       | `bundleClient`: rolldown, for recipes that serve a browser client           |
| `inline-image` | Draws an image in terminals that speak iTerm2 or kitty graphics             |

Provider selection is deliberately **not** here. That lives in
[`recipes/_shared/model.ts`](../../recipes/_shared/model.ts), which imports
every provider package. Keeping it out means a recipe in `recipes-extras/`
can depend on this package without pulling all fifteen providers into its
lockfile, which is the whole reason those recipes install separately.
