# Plan: a shared model selector for recipes

Internal to `recipes/`. Not shipped as a package: provider selection is recipe
ergonomics, and the library stays unopinionated about which provider you wire.

## Why

Twelve recipes need a `LanguageModel`; exactly one (`basic-usage`) lets you
choose it from the command line. The rest hardcode a provider and read a fixed
env var, so trying `dashboard-briefing` or `deep-research` on a different model
means editing the file. The multi-model recipes (`model-council`,
`multi-model-compare`, `multi-model-fallback`, `model-escalation`) each build
two or three services inline, reading three env keys apiece.

Two unrelated things are also both called "provider" today:

- `providerChoice` / `choiceFlag` (`_shared/argv.ts`): picks among typed
  _capability_ providers (speech, web-read, grounding). Four recipes.
  **Decision: leave it alone.** It is a genuinely different axis. Optionally
  rename to `capabilityChoice` in phase B to end the naming collision.
- `--provider` / `--base-url` / `--dialect` (`basic-usage`): LLM wire protocol
  and gateway coordinates. This is what the selector replaces.

## The spec string: `provider:model`

```
anthropic:claude-sonnet-5
google:gemini-2.5-pro
openai:gpt-5
mistral:mistral-large-latest
openrouter:openai/gpt-4o-mini
requesty:openai/gpt-4o
gpt-4o-mini                       # no colon: the default gateway
```

**Split on the first colon only.** OpenRouter model ids legitimately contain
colons (`meta-llama/llama-3-8b:free`, `openai/gpt-4o:extended`); a naive
`split(":")` breaks them. A bare model with no colon resolves to the default
gateway, so existing `--model gpt-4o-mini` invocations keep working.

## Registry

**Responses everywhere it is available**, including both gateways (verified:
OpenRouter documents `POST /v1/responses`; Requesty confirmed in practice).
`chat-completions` therefore drops out of the recipe registry entirely and
`--dialect` dies. The package still ships for users who need it; a chat-only
endpoint can be reached by adding an explicit key later if one ever comes up.

| Key          | Package   | Base URL                        | Env                                   |
| ------------ | --------- | ------------------------------- | ------------------------------------- |
| `openai`     | responses | default                         | `OPENAI_API_KEY`                      |
| `openrouter` | responses | `https://openrouter.ai/api/v1`  | `OPENROUTER_API_KEY` -> `LLM_API_KEY` |
| `requesty`   | responses | `https://router.requesty.ai/v1` | `REQUESTY_API_KEY` -> `LLM_API_KEY`   |
| `anthropic`  | anthropic | default                         | `ANTHROPIC_API_KEY`                   |
| `google`     | google    | default                         | `GOOGLE_API_KEY`                      |
| `mistral`    | mistral   | default                         | `MISTRAL_API_KEY`                     |

Direct provider keys stay alongside the gateways: the recipes are partly a
showcase for the typed provider packages, and routing everything through a
gateway would leave those packages unexercised. `anthropic` needs a
`defaultMaxTokens` default supplied by the registry.

## Phase A: `_shared/model.ts` (no CLI dependency)

```ts
parseModelSpec("anthropic:claude-sonnet-5")
// -> { provider: "anthropic", model: "claude-sonnet-5" }

makeModel(spec): Effect<LanguageModel.Service, ConfigError | UnknownProvider, HttpClient>
modelLayer(defaults?): Layer<LanguageModel, ConfigError | UnknownProvider, HttpClient>
```

`makeModel` is the primitive because the council / fallback recipes need
_services_ to build tiers from; `modelLayer` is sugar for the common case.
Driven by the existing `flagValue`, so **zero runner changes**. Unit-test the
parser: first-colon split, bare model, unknown provider -> typed error.

Migration order: `basic-usage` first (deletes its `--dialect` wiring, proving
the extraction), then the four multi-model recipes (where the duplication
actually hurts), then the eight hardcoded ones (a net feature: model choice
they never had).

## Phase B: adopt `effect/unstable/cli`

Confirmed present in `effect@4.0.0-rc.111`: `Command`, `Flag`, `Argument`,
`Param`, `Primitive`, `Prompt`, `Completions`, `HelpDoc`, `CliConfig`,
`CliError`.

The payoff for multi-model recipes is that a flag is a value, so the spec
parser becomes a combinator applied per flag name:

```ts
const modelFlag = (name: string, fallback: string) =>
  Flag.string(name).pipe(
    Flag.withDefault(fallback),
    Flag.mapEffect(parseModelSpec), // typed CliError on a bad spec
    Flag.withDescription("provider:model, e.g. anthropic:claude-sonnet-5"),
  )

const fast = modelFlag("fast", "google:gemini-2.5-flash")
const pro = modelFlag("pro", "anthropic:claude-sonnet-5")
```

Also gains `--help`, `Flag.withAlias` short forms, `Flag.choice` (replacing
`choiceFlag`), and shell completions via `Completions`.

**Costs, all known:**

- `Command.Environment = FileSystem | Path | Terminal | ChildProcessSpawner |
Stdio`. Runners must add platform services: `NodeServices.layer` /
  `BunServices.layer` (both exist, one line each). **Verify Deno's `Terminal`
  and `Stdio` under node-compat before migrating `run-deno.ts`.**
- Flags currently parse at module top level as constants. CLI parses inside an
  Effect handler, so each `app.ts` restructures to take flags as inputs to
  `main`. Real refactor, healthy outcome.
- `effect/unstable/cli` is unstable and may churn. Acceptable: recipes are
  internal and the repo already depends on `unstable/http` and
  `unstable/process` throughout.

**Scope: all 12 recipes**, for consistency, migrated one at a time starting
with `model-council` (the multi-model case that justifies the whole thing).

## Not in scope

- Shipping any of this as a package.
- Touching `providerChoice` beyond an optional rename.
