# Agent skills for effect-uai

A drop-in skill that teaches an AI coding agent how to build with
`effect-uai`: the primitives, provider wiring, and how to reach into the
recipe library for a given scenario. Distributed via the
[skills.sh](https://skills.sh) CLI.

## Layout

```
skills/
└── effect-uai/   # the skill: philosophy, primitives, provider wiring, recipe library
```

One `SKILL.md` with frontmatter (`name`, `description`, `license`) and a
body. It loads lazily: the agent reads the description until the intent
matches, so installing has no token cost until it triggers.

## Recipes are the reference library

Rather than one skill per recipe (which lagged as the recipes grew), the
skill points the agent at the recipe library: `recipes/<name>/` in the
repo, rendered at <https://effect-uai.betalyra.com/recipes/>. Each
recipe's `README.md` is the walkthrough and `recipe.ts` / `app.ts` /
`run-*.ts` are the runnable code. The skill's catalog maps a scenario to
the recipe to start from; the agent opens (or fetches) that recipe and
adapts it.

## Installation

```sh
npx skills add betalyra/effect-uai
```

Installs the `effect-uai` skill; the CLI auto-discovers the `skills/`
directory. The frontmatter follows the
[Agent Skills specification](https://agentskills.io/specification).

## When the agent reaches for it

The skill loads on broad signals like "I'm building an AI agent in
Effect" or "wire up the LanguageModel service." From there it recommends
the matching recipe (see the catalog in the skill body) and composes
patterns in the loop body, since the loop body is just an Effect.

## Authoring conventions

If you fork or extend the skill, keep the conventions:

- **Frontmatter is the trigger.** The `description` is what the agent
  sees by default; make it specific about _when_ to use the skill.
- **Point at recipes, don't inline them.** A new pattern becomes a new
  recipe under `recipes/`, surfaced through the catalog, not a new skill.
- **Code samples are typecheck-clean.** They get pasted into user
  projects; broken samples cost more than missing ones.

## License

MIT, same as `effect-uai` itself.
