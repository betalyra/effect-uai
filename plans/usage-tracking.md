# Usage and cost tracking. design proposal

Status: draft / for discussion. Proposes a unified `Usage` + `Cost` model
in `@effect-uai/core` that spans every capability (language models,
embeddings, search, speech, transcription, music, sandbox) and supports
both provider-reported cost and cost computed from a price card.

## 1. The problem

Today each capability reports usage in its own shape, and most report
nothing:

| Capability        | Type                                                                   | Fields                                                                                                                          | Cost? |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | :---: |
| LanguageModel     | [`Items.Usage`](../packages/core/src/domain/Items.ts)                  | `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` |  no   |
| EmbeddingModel    | [`Embedding.Usage`](../packages/core/src/embedding-model/Embedding.ts) | `inputTokens?`                                                                                                                  |  no   |
| WebSearch         | none (deferred)                                                        | results only; provider cost stays on `raw`                                                                                      |  n/a  |
| Transcriber       | [`TranscriptResult`](../packages/core/src/domain/Transcript.ts)        | `duration?` only                                                                                                                |  no   |
| SpeechSynthesizer | [`AudioBlob`](../packages/core/src/domain/Audio.ts)                    | `duration?` only                                                                                                                |  no   |
| MusicGenerator    | [`MusicResult`](../packages/core/src/domain/Music.ts)                  | none                                                                                                                            |  no   |
| Sandbox           | [`ExecResult`](../packages/core/src/sandbox/Sandbox.ts)                | `durationMs` only                                                                                                               |  no   |

Three problems fall out:

1. **No common currency.** A multi-step agent that calls an LLM, runs two
   searches, and executes code in a sandbox produces three incompatible
   usage shapes and no way to answer "what did this run cost?".
2. **Naming drift.** LanguageModel uses snake_case nested details
   (`input_tokens_details.cached_tokens`); EmbeddingModel uses camelCase
   (`inputTokens`); WebSearch invented `costUsd`. There is no shared
   vocabulary.
3. **No cost layer.** Some providers report money, some do not, and the
   ones that do disagree on form and location (see 2.1). LLM/embedding cost
   has to be computed from a price card, which the library has no model for.

Search usage was briefly modeled (a `SearchUsage` with `costUsd` /
`requests`) and then pulled back out: the providers are too inconsistent to
normalize ad hoc (2.1), so search cost is deferred to this unified design.
Today `WebSearch` keeps only `raw`, where any provider-reported figure
survives.

## 2. The metering kinds

Across every provider an AI library touches, billing reduces to a small,
closed set of meters. This is the key observation: the "units" are not an
open physical-dimension space, they are a fixed domain vocabulary.

| Meter                | Unit              | Who bills this way                                |
| -------------------- | ----------------- | ------------------------------------------------- |
| tokens               | count             | LLMs, embeddings, rerankers, token-priced TTS/STT |
| characters           | count             | TTS (ElevenLabs, OpenAI per-character)            |
| audio / compute time | seconds           | STT, TTS, music, sandbox CPU time                 |
| requests             | count             | search, per-call APIs                             |
| images               | count             | image generation                                  |
| documents            | count             | rerankers, some search "search units"             |
| money                | currency          | anything that reports cost directly (Exa)         |
| credits              | provider-internal | a few providers meter abstract credits            |

Tokens carry sub-dimensions because they are priced at different rates:
plain input, plain output, reasoning (billed at the output rate),
cache-read (cheaper than input), cache-write (Anthropic, pricier than
input), and audio tokens (multimodal). Everything else is a single scalar.

**`credits` are not modeled as a first-class meter, but not thrown away
either.** A credit count is provider-internal and non-comparable (a Tavily
credit is not a Brave dollar), so it does not earn a portable field. But
where a provider reports one (Tavily, below) it stays on `raw`, and it
converts to money through the caller's price card via `perRequest`.

### 2.1 Worked example: the five search providers disagree

The search capability is the sharp case that motivated deferring search
cost. The five backends split on both _what_ they report and _where_:

| Provider   | Reports? | Where                | What                                                  |
| ---------- | :------: | -------------------- | ----------------------------------------------------- |
| Exa        |   yes    | response body        | `costDollars.total` (USD)                             |
| Brave      |   yes    | response **headers** | `X-Request-Total-Cost` (USD) + request / query counts |
| Tavily     |   yes    | response body        | `usage.credits` (1 basic, 2 advanced)                 |
| Perplexity |    no    | .                    | results / id / server_time only                       |
| You.com    |    no    | .                    | hits / latency only (cost is dashboard-side)          |

Two design consequences this carries into the model:

- **Cost can arrive in headers, not just the body** (Brave). An adapter
  must be free to source `cost` from response headers; the `Usage` shape
  must not assume the body.
- **Counts and credits are real** (Brave, Tavily). `requests` covers the
  counts; credits stay on `raw` and become money through `perRequest`
  pricing. Only Exa and Brave hand back money directly.

## 3. What Effect already gives us (and the units-of-measure landscape)

The user asked what unit-type tooling exists. Findings:

**In Effect itself:**

- [`BigDecimal`](../../effect-smol/packages/effect/src/BigDecimal.ts):
  arbitrary-precision decimal with `sum`, `sumAll`, `multiply`, `scale`,
  `fromNumber` / `fromString`. This is the right carrier for **money**:
  accumulating thousands of sub-cent LLM costs as `number` drifts on
  float; `BigDecimal` is exact.
- [`Duration`](../../effect-smol/packages/effect/src/Duration.ts): already
  used across the codebase for audio / exec duration. The right carrier
  for **time meters** (`Duration.sum`, `Duration.toSeconds`).
- [`Brand`](../../effect-smol/packages/effect/src/Brand.ts): nominal types,
  so a bare `number` can be branded `Tokens` or a `BigDecimal` branded
  `Usd` for compile-time safety with no runtime cost.

There is no `Money` type in Effect.

**Dedicated units-of-measure libraries (surveyed, not recommended here):**

- _Compile-time dimensional analysis_: `safe-units`, `uom-ts`, `ts-units`.
  These encode physical dimensions (length, mass, time) in the type system
  with type-level arithmetic. Powerful for physics / engineering, but the
  meters here (tokens, requests, images) are not physical dimensions, need
  no inter-unit conversion, and the type-level machinery balloons compile
  times for no payoff.
- _Runtime quantity math_: `js-quantities`, `unitmath`, `convert-units`,
  `mathjs`. Built for unit conversion (km to miles). We never convert
  tokens to characters, so this is dead weight.
- _Money_: `dinero.js` (v2, integer minor units + currency), `currency.js`,
  `decimal.js` / `big.js`. `dinero` is well-designed, but `BigDecimal` +
  an ISO-4217 currency string covers our need (report and sum cost)
  without a dependency.

**Recommendation: no external units library.** The meter set is small,
closed, and conversion-free. Lean on Effect's `BigDecimal` (money),
`Duration` (time), and optionally `Brand` (nominal safety). A general UoM
library solves a problem we do not have and adds compile cost or a dep.

## 4. Proposed core types

New module `packages/core/src/usage/Usage.ts`, exported as
`@effect-uai/core/Usage`.

### 4.1 `Usage`. normalized meter readings

A flat, fully-optional, additive record. Flat-and-additive (not a tagged
union per capability) is the deliberate choice: it makes `Usage` a monoid,
so a heterogeneous agent run folds into one total with a plain combine.
Token sub-dimensions nest under `tokens` to keep the LLM-rich part
readable.

```ts
export type TokenUsage = {
  readonly input?: number
  readonly output?: number
  readonly total?: number
  readonly reasoning?: number // subset of output, billed at the output rate
  readonly cacheRead?: number // subset of input, cheaper than input
  readonly cacheWrite?: number // Anthropic cache creation, pricier than input
  readonly audioInput?: number
  readonly audioOutput?: number
}

export type Usage = {
  readonly tokens?: TokenUsage // LLMs, embeddings, rerankers
  readonly characters?: number // TTS
  readonly seconds?: Duration.Duration // STT / TTS / music audio, sandbox compute
  readonly requests?: number // search, per-call APIs
  readonly images?: number // image generation
  readonly documents?: number // rerank units
  readonly cost?: Cost // provider-reported cost, when the wire carries it
  readonly raw?: unknown // provider-native usage object, never lossy
}
```

### 4.2 `Cost`. normalized money

```ts
export type Cost = {
  readonly amount: BigDecimal.BigDecimal // exact; safe to accumulate
  readonly currency: string // ISO 4217, default "USD"
}

export const usd: (amount: number | string) => Cost // Cost.usd("0.0021")
```

`amount` is `BigDecimal`, not `number`, precisely because the headline use
is summing many tiny costs across a run. `currency` is a string rather than
an enum so an unlisted currency is never a compile error; helpers default
to `"USD"`.

### 4.3 Monoid. the whole point

```ts
export const empty: Usage // {}
export const combine: (a: Usage, b: Usage) => Usage // field-wise add; Duration.sum; BigDecimal.sum on cost (same currency)
export const sum: (usages: Iterable<Usage>) => Usage
```

`combine` adds each numeric field, `Duration.sum`s `seconds`, and
`BigDecimal.sum`s `cost.amount` when currencies match (mismatch keeps them
separate, see 4.5). `raw` is dropped on combine (an aggregate has no single
native object).

### 4.4 `Pricing`. deriving cost when the provider does not report it

LLMs and embeddings never return money, so cost is `Usage` times a rate
card. Rates are per-unit `BigDecimal`; a `perMillionTokens` helper covers
the way vendors actually quote ("$3.00 / 1M input tokens").

```ts
export type TokenRates = {
  readonly input?: BigDecimal.BigDecimal // per token
  readonly output?: BigDecimal.BigDecimal
  readonly reasoning?: BigDecimal.BigDecimal // defaults to `output` when unset
  readonly cacheRead?: BigDecimal.BigDecimal
  readonly cacheWrite?: BigDecimal.BigDecimal
  readonly audioInput?: BigDecimal.BigDecimal
  readonly audioOutput?: BigDecimal.BigDecimal
}

export type Pricing = {
  readonly currency: string
  readonly tokens?: TokenRates
  readonly perCharacter?: BigDecimal.BigDecimal
  readonly perSecond?: BigDecimal.BigDecimal
  readonly perRequest?: BigDecimal.BigDecimal
  readonly perImage?: BigDecimal.BigDecimal
  readonly perDocument?: BigDecimal.BigDecimal
}

export const perMillionTokens: (usd: number) => BigDecimal.BigDecimal

/** Cost of a usage under a price card. Multiplies each present meter by its rate. */
export const costOf: (usage: Usage, pricing: Pricing) => Cost

/** Reported cost wins; otherwise compute from pricing; otherwise None. */
export const resolveCost: (usage: Usage, pricing?: Pricing) => Option.Option<Cost>
```

Pricing is **caller-supplied, not shipped**. Vendor prices change weekly
and are region / tier / contract dependent; baking a price table into the
library guarantees it is wrong. The library owns the _mechanism_
(`costOf`), the app owns the _numbers_. (A community price-card package
could ship separately, like a models registry.)

### 4.5 Attribution. `UsageEntry` / `UsageReport`

A flat total answers "how much" but not "where". For an agent run you want
the itemized bill. The accumulator keeps provenance and only collapses on
demand.

```ts
export type UsageEntry = {
  readonly capability: string // "language-model" | "web-search" | "sandbox" | ...
  readonly provider?: string // "openai" | "perplexity" | ...
  readonly model?: string
  readonly label?: string // step name in a run
  readonly usage: Usage
}

export type UsageReport = {
  readonly entries: ReadonlyArray<UsageEntry>
  readonly total: Usage // Usage.sum(entries.map(e => e.usage))
}

export const groupBy: (
  report: UsageReport,
  key: (e: UsageEntry) => string,
) => ReadonlyArray<{ readonly key: string; readonly total: Usage }>
```

This also resolves the **mixed-meter and mixed-currency** caveat: a flat
`total` that sums sandbox seconds with audio seconds, or USD with EUR, is
meaningless. `groupBy` (by capability, provider, or currency) lets a caller
total only within a comparable group. The per-operation `Usage` is always
single-kind, so only aggregation needs this care.

## 5. Mapping the existing surfaces in

Lossless adapters, so nothing breaks on day one:

- **`Items.Usage` (LLM)**: `input_tokens` to `tokens.input`,
  `output_tokens` to `tokens.output`, `total_tokens` to `tokens.total`,
  `input_tokens_details.cached_tokens` to `tokens.cacheRead`,
  `output_tokens_details.reasoning_tokens` to `tokens.reasoning`. Anthropic
  `cache_creation_input_tokens` (currently dropped) gains a home as
  `tokens.cacheWrite`.
- **`Embedding.Usage`**: `inputTokens` to `tokens.input`.
- **WebSearch**: no usage field today (deferred, 2.1). When usage lands,
  cost comes from Exa's body `costDollars`, Brave's `X-Request-Total-Cost`
  header, and Tavily's `usage.credits` (via `perRequest`); the count meters
  map to `requests`.
- **`TranscriptResult.duration` / `AudioBlob.duration`**: surface as
  `seconds` on a `Usage` (duration is already a `Duration`).
- **`ExecResult.durationMs`**: `seconds: Duration.millis(durationMs)`.

## 6. Integration points

- **Agent loop**: [`Turn`](../packages/core/src/domain/Turn.ts) already
  carries `usage` and emits a mid-stream
  [`UsageUpdate`](../packages/core/src/domain/Turn.ts) event. The loop folds
  each turn's `Usage` into a running `UsageReport` with
  `Usage.combine`; cumulative streaming usage is the same monoid applied
  incrementally.
- **Observability**:
  [`Metrics.ts`](../packages/core/src/observability/Metrics.ts) has
  `withRate(weight)` with no token model. `weight = u => u.tokens?.output ?? 0`
  drops in once `Usage` exists, giving tokens-per-second for free.
- **Tools**: a tool that calls a metered capability (the
  [`webSearchTool`](../packages/core/src/web-search/WebSearchTool.ts)) can
  attach a `Usage` to its result so the loop's report includes tool spend,
  not just model spend.

## 7. Phasing

1. **Phase 1, non-breaking.** Ship `@effect-uai/core/Usage`: the `Usage`,
   `Cost`, `Pricing` types, the monoid (`empty` / `combine` / `sum`),
   `costOf` / `resolveCost`, and the `UsageReport` accumulator. Add adapters
   from the existing per-capability usage types. Nothing else changes.
2. **Phase 2, opt-in.** A loop helper that accumulates a `UsageReport`
   across a run, and the `Metrics.withRate` token weight. Wire `cacheWrite`
   through the Anthropic adapter (the one field currently dropped).
3. **Phase 3, converge (breaking, batched into a major).** Migrate
   capability responses to carry `Usage` directly and retire
   `Embedding.Usage` / `SearchUsage`. `Items.Usage` either becomes a
   serialization detail behind `Usage` or is replaced outright.

## 8. Open questions

1. **`Brand` the scalars?** Branding `Cost.amount` as `Usd`-ish buys
   currency-mismatch safety at the cost of ceremony at every construction
   site. Leaning no for token counts (plain `number`), maybe for `Cost`.
2. **`seconds` as `Duration` vs `number`.** `Duration` is consistent with
   the rest of the codebase and composes with `Duration.sum`, but it is
   heavier than a scalar for what is always "seconds of audio/compute".
   Leaning `Duration` for consistency.
3. **Should `total` tokens be stored or derived?** Providers disagree
   (some send `total_tokens`, some do not). Storing it verbatim preserves
   provider intent; deriving `input + output` is simpler but can diverge
   from the billed number. Leaning: store what the provider sent, leave
   `total` `undefined` otherwise (do not synthesize).
4. **Cost on every response, or only via the report layer?** Putting
   `cost` on `Usage` lets a provider that reports money (Exa) fill it
   directly, while computed cost lives in the report layer. That split is
   in this proposal; confirm it is the right seam.
