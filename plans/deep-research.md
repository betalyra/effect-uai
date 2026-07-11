# Plan: `DeepResearch` capability

## What this is

A deep research agent takes one question, autonomously runs dozens of web searches
over 5 to 30 minutes, and returns a long report with inline citations. Three
providers ship this as a real API: **OpenAI**, **Gemini**, **Perplexity**. It is a
provider-hosted agent, but unlike a conversational runtime it needs **no
server-side conversation state you manage**: submit one question, collect one
report. The job id is ephemeral plumbing, not a conversation you own.

That is why it fits effect-uai cleanly. `LanguageModel` is a stateless
request-in / turn-out capability; `DeepResearch` is a stateless
question-in / report-out capability. No history threading, no `ConversationRef`,
none of the persisted-chat machinery. The one new thing is that the request is a
**long-running background job** (submit, poll, collect), not a streamed turn.

> Wire caveat: the OpenAI and Gemini deep-research surfaces are recent preview
> APIs. Exact model/agent ids, dates, and citation-object schemas below come from
> doc research and **must be re-verified against live references** before types are
> locked (per the verify-referenced-paths rule). The *shapes* are solid; the
> *string literals* and citation-object fields are the risk.

## Provider landscape

Researched July 2026. Two families ship a real deep-research API, and they share
one shape at the interface. **Two of them (Exa, Jina) are already effect-uai
providers** as web-search backends, so adding research there is a second module in
an existing package, not a new one.

### Family A: LLM-provider report writers (long prose + citations)

| Provider | Endpoint | Model / agent | Async model | Report + citations |
|---|---|---|---|---|
| **OpenAI** | `POST /v1/responses` | `o3-deep-research`, `o4-mini-deep-research` | `background: true` → poll `GET /v1/responses/{id}` (or webhook) | `message` item; `content` text with `annotations[]` `{url, title, start_index, end_index}` |
| **Gemini** | `POST /v1beta/interactions` | `deep-research-preview-04-2026`, `-max-` | `background: true` → poll `GET /v1beta/interactions/{id}` | final `step` text; citation-object shape needs live-doc check |
| **Perplexity** | `POST /v1/async/sonar` (sync `/v1/sonar`) | `sonar-deep-research` | dedicated async endpoint → poll `GET /v1/async/sonar/{id}` | `choices[0].message.content` + `citations[]` + `search_results[]` |
| **Parallel** | Task API (`platform.parallel.ai`) | processor tiers | async task → poll | evidence-based outputs with per-output provenance |
| **You.com** | ARI (Advanced Research & Insights) API | ARI | async | cited report |

### Family B: search-infra research (structured / precise, citation-grounded)

| Provider | Endpoint | Model | Async model | Report + citations |
|---|---|---|---|---|
| **Exa** (in repo) | `POST` research create-task | `exa-research` tiers (`deep-lite`/`deep`/`deep-reasoning`) | **create task → poll `get_task(id)`** | **structured JSON against an `output_schema`, field-level citations** |
| **Jina** (in repo) | `POST https://deepsearch.jina.ai/v1/chat/completions` | `jina-deepsearch-v1` | **sync streaming (SSE)**, no poll | precise answer + citations, not long-form |
| **Valyu** | deep research API | - | async | accuracy-first cited answer |

The common shape across everything except Jina: **submit with a background/async
flag (or create a task), get a job id, poll for a terminal status, read one cited
result.** OpenAI/Gemini run it as a background turn of their hosted-agent runtime;
Perplexity/Exa/Parallel/You.com/Valyu are standalone async endpoints. **Exa is the
cleanest fit** (create-task + `output_schema` + poll maps 1:1 onto the interface),
so it, not Perplexity, becomes the reference implementation. Jina is the one
outlier: a long synchronous streaming call, no job id.

The **structured-output** split matters for the interface. Family A returns prose;
Exa (and optionally Parallel) returns typed JSON against a caller-supplied schema,
each field grounded by citations. That overlaps effect-uai's existing
`StructuredFormat` machinery, so the interface grows an optional `outputSchema`
(see below): omit it for a prose report, pass it for grounded structured data on
providers that support it.

### Not deep research (explicitly out)

- **Anthropic** and **xAI** ship only server-side search *tools* (`web_search`;
  xAI adds `x_search`) inside the normal chat loop. Multi-hop within a turn, but no
  background job, no report contract. xAI's "DeepSearch" is exactly this: enabling
  `web_search` + `x_search` on `/v1/responses`. "Deep research" on these is a
  client-side recipe over the existing `Loop` + the search tool, not a
  `DeepResearch` provider.
- **Mistral** has no research surface. **Tavily** (in repo) is search-only; its
  roadmap is opaque post-Nebius-acquisition. **Linkup** is a parallel-search API,
  not a report-writing research agent.

## Why it is a background job, not a streamed turn

Runs take 5 to 30 minutes and cost \$0.40 to \$8 per query. A synchronous HTTP call
risks client/proxy timeouts, so all three providers push you to background + poll.
Modeling this as a `Stream<TurnEvent>` like `LanguageModel` would be wrong: the job
outlives a single connection, can be detached and collected later, and terminates
in one report rather than a live token stream. Model it as an **async job** with an
optional progress stream layered on top.

The repo already has the poll idiom this needs: `Effect.retry(effect, { schedule,
while })` (see `MicrosandboxSandbox.retryOnSettle`, `DenoSandbox` handshake). The
`research` method wraps submit + poll behind one `Effect`; the job ref is exposed
for the detach case.

## Proposed interface

A new core capability, sibling to `LanguageModel` / `MusicGenerator` /
`Transcriber`. Working name **`DeepResearch`**.

### Domain (`packages/core/src/domain/Research.ts`)

```ts
export type ResearchRequest = {
  readonly question: string
  /** Model / agent id. Provider default if omitted (each narrows to a literal union). */
  readonly model?: string
  /**
   * Depth hint, mapped per provider: Perplexity `reasoning_effort`,
   * Gemini agent variant (`-preview` vs `-max-`), OpenAI model + `max_tool_calls`.
   * A hint, not a contract: adapters map it to the nearest knob.
   */
  readonly effort?: "low" | "medium" | "high"
  /** Cost/latency cap. OpenAI `max_tool_calls`; warn-dropped where unsupported. */
  readonly maxSearches?: number
  /**
   * Optional structured output. When set and the provider supports it (Exa,
   * maybe Parallel), the report comes back as typed JSON grounded field-by-field
   * instead of prose. Reuses the existing StructuredFormat, same as
   * `CommonRequest.structured`. Omit for a prose report (Family A, Jina).
   */
  readonly outputSchema?: StructuredFormat.StructuredFormat<unknown>
}

export type ResearchReport = {
  readonly text: string
  readonly citations: ReadonlyArray<Items.Annotation>   // reuse the existing Annotation union
  /** Present when `outputSchema` was requested and supported (Exa). Decode with the schema. */
  readonly structured?: unknown
  readonly usage?: Items.Usage
}

/** Opaque, provider-tagged handle to a running background job. */
export type ResearchJobRef = {
  readonly _tag: "ResearchJobRef"
  readonly provider: string
  readonly id: string
}

export type ResearchStatus = "queued" | "in_progress" | "completed" | "failed"

/** Progress events for the optional live stream; the job still runs server-side. */
export type ResearchEvent =
  | { readonly _tag: "ReasoningDelta"; readonly text: string }   // "thought" / thinking summaries
  | { readonly _tag: "SearchStarted"; readonly query: string }
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "Report"; readonly report: ResearchReport } // terminal
  | { readonly _tag: "Unknown"; readonly provider: string; readonly raw: unknown }
```

`Items.Annotation` (`UrlCitation` `{type,url,title,start_index,end_index}` / …)
already exists and already covers OpenAI's `annotations[]` and Perplexity's
`citations[]` + `search_results[]`. Reuse it. This is the deferred Phase-2 citation
payoff from `native-grounding`: research agents return structured citations and we
have the type.

### Service (`packages/core/src/research/DeepResearch.ts`)

```ts
export type DeepResearchService = {
  /**
   * Submit and await the report. The adapter owns the background submit + poll
   * loop; the caller sees one long-running Effect. Interruption best-effort
   * cancels the server job where the provider supports it.
   */
  readonly research: (request: ResearchRequest) => Effect<ResearchReport, AiError>
  /** Optional progress stream (searches, reasoning, deltas); terminates in Report. */
  readonly researchStream: (request: ResearchRequest) => Stream<ResearchEvent, AiError>
  /** Detach: submit now, collect later (jobs outlive the process). */
  readonly submit: (request: ResearchRequest) => Effect<ResearchJobRef, AiError>
  readonly status: (ref: ResearchJobRef) => Effect<ResearchStatus, AiError>
  readonly collect: (ref: ResearchJobRef) => Effect<ResearchReport, AiError>
  /** Cancel a running job. No-op / Unsupported where the provider can't (Perplexity). */
  readonly cancel: (ref: ResearchJobRef) => Effect<void, AiError>
}

export class DeepResearch extends Context.Service<DeepResearch, DeepResearchService>()(
  "@betalyra/effect-uai/DeepResearch",
) {}
```

`research` is the common case (one call, hides the poll loop). `submit`/`status`/
`collect` expose the job for fire-and-forget over process restarts, which matters
for 30-minute jobs. Registered by each provider `layer` alongside its existing
tags, same `Layer.merge(typed, generic)` pattern as every other provider. A
provider without a research surface does not ship the tag, and `DeepResearch` calls
fail at `Effect.provide` with a type error (the capability-gating we already use).

### `research` = submit + poll, in Effect

Effect gives us the poll primitive directly: `Effect.repeat(self, { schedule,
until })` repeats a success-producing effect on a `Schedule` until a predicate on
its value holds. `until` accepts a `Refinement`, so the result type narrows to the
terminal status. No hand-rolled loop.

```ts
const research = (request) =>
  submit(request).pipe(
    Effect.flatMap((ref) =>
      collect(ref).pipe(
        // best-effort server-side cancel if the caller interrupts (Effect built-in)
        Effect.onInterrupt(() => Effect.ignore(cancel(ref))),
      ),
    ),
  )

const collect = (ref) =>
  // repeat the status fetch on a jittered fixed cadence until terminal.
  // jobs run minutes, so a ~10s spaced poll is plenty; jitter avoids sync herds.
  status(ref).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds").pipe(Schedule.jittered),
      until: (s: ResearchStatus): s is "completed" | "failed" =>
        s === "completed" || s === "failed",
    }),
    Effect.flatMap((s) => (s === "failed" ? Effect.fail(researchFailed(ref)) : fetchReport(ref))),
    // bound total wait so a stuck job doesn't hang forever
    Effect.timeoutFail({ duration: "45 minutes", onTimeout: () => researchTimeout(ref) }),
  )
```

Everything here is stock effect@4.0.0-beta.57: `Effect.repeat` with `{ schedule,
until }`, `Schedule.spaced`/`jittered` for cadence, `Effect.timeoutFail` for the
overall cap, `Effect.onInterrupt` for cancel. The repo already uses this family
(`Effect.retry({ schedule, while })` in `MicrosandboxSandbox`, `DenoSandbox`). So
the shared `Job<A>` helper is thin: `submit` + this `collect` + `cancel`, one small
generic wrapper, not a bespoke poll engine (see open questions).

## Per-provider mapping

### Exa (reference implementation, do first)

Already an effect-uai provider (`packages/providers/exa`, web-search today). Its
Research API is the exact async-job shape, so it defines the interface.

- **submit:** create a research task with `{ instructions: question, output_schema? }`
  (`POST` on the research resource; SDK `research.create_task`). Optional
  `output_schema` drives structured output. Returns a task id.
- **status / collect:** poll `get_task(id)` (SDK `poll_task`) until the task is
  `completed` / `failed`; `list_tasks` for enumeration. Result is structured JSON
  with **field-level citations**, or prose when no schema was given. Citations →
  `Items.Annotation`; structured payload → `ResearchReport.structured`.
- **effort:** `effort` → tier (`deep-lite` / `deep` / `deep-reasoning`).
- **outputSchema:** map `StructuredFormat` → Exa `output_schema` (JSON Schema),
  same conversion the providers already do for `CommonRequest.structured`. This is
  the one provider that exercises the structured path.
- **cancel:** verify against docs; if absent, `cancel` fails `Unsupported`.
- Package: a `Research` module in `@effect-uai/exa`. API-key auth (`x-api-key`).
- Cleanest end-to-end test target: create-task + poll + structured decode all route
  through the real codec.

### Perplexity

A plain async REST job, no agent-runtime baggage. Prose report (no `outputSchema`).

- **submit:** `POST /v1/async/sonar` `{ request: { model: "sonar-deep-research",
  messages: [{role:"user", content: question}], reasoning_effort }, idempotency_key? }`
  → `{ id, status: CREATED }`.
- **status / collect:** `GET /v1/async/sonar/{id}` → `{ status: CREATED |
  IN_PROGRESS | COMPLETED | FAILED, response }`; on `COMPLETED`, report from
  `response.choices[0].message.content`, citations from `response.citations[]`
  (urls) + `response.search_results[]` (`{title, url, date, snippet}`), both mapped
  to `Items.UrlCitation`.
- **effort:** `effort` → `reasoning_effort` (`low`/`medium`/`high`; `minimal` also
  exists provider-side).
- **cancel:** none exposed; `cancel` fails `AiError.Unsupported`, `research`
  interruption drops the client wait (server job runs to completion).
- **researchStream:** sync `/v1/sonar` with `stream:true` is available for shorter
  runs; the async job itself is poll-only, so `researchStream` on Perplexity is
  best-effort (poll-and-emit, or fall back to sync streaming). Provider-typed
  extras off the interface: `search_mode` (web/academic/sec),
  `search_domain_filter`, `web_search_options`.
- Package: a `DeepResearch` module in `@effect-uai/perplexity` (today a web-search
  provider). API-key auth, `Authorization: Bearer`.

### OpenAI

- **submit:** `POST /v1/responses` `{ model: "o3-deep-research", input: question,
  background: true, tools: [{type:"web_search_preview"}, ...], max_tool_calls }`.
  **Requires at least one data-source tool** (`web_search_preview`, `file_search`
  with `vector_store_ids`, or `mcp`); `code_interpreter` optional for analysis.
  Returns a response id.
- **status / collect:** `GET /v1/responses/{id}` while `status` is
  `queued`/`in_progress`; on `completed`, report from the `message` output item's
  text, citations from its `content[].annotations[]`
  (`{url, title, start_index, end_index}` → `Items.UrlCitation`).
- **effort:** map to model (`o3-deep-research` vs `o4-mini-deep-research`) +
  `maxSearches` → `max_tool_calls`.
- **cancel:** `POST /v1/responses/{id}/cancel`.
- **researchStream:** Responses SSE (`response.created`, `.output_item.added`,
  `response.web_search_call.*`, `response.output_text.delta`, `.completed`), with
  resume via `GET /v1/responses/{id}?stream=true&starting_after={seq}`. Reuses the
  existing Responses codec (`packages/providers/responses/src/codec.ts`); the
  deep-research delta events map onto `ResearchEvent`.
- Package: a `DeepResearch` module in `@effect-uai/responses` (it already speaks
  `/v1/responses`; deep research is a background variant of the same wire). Webhook
  completion is out of scope v1 (poll only).

### Gemini

- **submit:** `POST /v1beta/interactions` `{ input: question, agent:
  "deep-research-preview-04-2026", background: true }`, header
  `x-goog-api-key`. Returns an interaction id.
- **status / collect:** `GET /v1beta/interactions/{id}` while
  `status: in_progress`; on `completed`, report from the final `step` text.
  Citation-object shape needs a live-doc check before mapping to `Items.Annotation`
  (the fetched docs showed citations embedded in report text, not a separate
  schema).
- **effort:** map to agent variant (`-preview` fast vs `-max-` comprehensive).
- **cancel:** `POST /v1beta/interactions/{id}/cancel`.
- **researchStream:** SSE `step.delta` (`{text | thought | image}`) +
  `interaction.completed`/`interaction.error`; `thinking_summaries: "auto"` →
  `ReasoningDelta`. Reconnect via `last_event_id`.
- Package: a focused `DeepResearch` module in `@effect-uai/google` that implements
  only the deep-research slice of the Interactions API (submit background
  interaction + poll), **not** the full conversational runtime. This is a third
  Google surface next to `generateContent` (`Gemini.ts`) and its tools, but a thin
  one.

### Jina (the sync-streaming outlier)

Already a provider (`packages/providers/jina`). DeepSearch does not fit the
job/poll model: it is one long synchronous streaming call.

- **research / researchStream:** `POST https://deepsearch.jina.ai/v1/chat/completions`
  `{ model: "jina-deepsearch-v1", messages, stream: true }`. OpenAI-compatible.
  SSE carries reasoning steps then the final answer; `research` drains the stream to
  the terminal answer, `researchStream` forwards deltas. No `submit`/`collect` job
  ref (or a synthetic one wrapping the in-flight stream).
- **Different product framing:** optimized for a precise cited *answer*, not a
  long-form report. Document the expectation difference; still fits
  `ResearchReport` (`text` + `citations`).
- Package: a `Research` module in `@effect-uai/jina`. API-key auth.
- This is the provider that proves `research` must not *assume* an async job: for
  Jina it is a streaming drain. The interface already allows this because `research`
  is defined by its result, not its transport.

### Others (new packages, later)

**Parallel** (Task API, async, provenance-tagged outputs, possibly structured),
**You.com ARI**, **Valyu** (accuracy-first). All plausibly fit the same
`submit`/`poll`/`collect` shape; add on demand once the core providers land.

## Recipe: `deep-research`

Mirror `native-grounding`'s structure (generic `recipe.ts` + `app.ts` provider
wiring + `run-node`/`run-bun`/`run-deno` runners). The recipe body is small because
there is no loop:

```ts
// recipe.ts
export const deepResearch = (cfg: { question: string; effort?: Effort }) =>
  DeepResearch.research({ question: cfg.question, effort: cfg.effort })
// app.ts: providerChoice("perplexity", "openai", "gemini") → matching layer
// print report.text, then the citation list
```

Optionally a streaming variant that forwards `researchStream` progress
(`SearchStarted` → "searching: …", `ReasoningDelta` → dim text) so a 20-minute run
shows life. Default question something current-events flavored, same as
`native-grounding`.

## Phasing

1. **Core capability.** `domain/Research.ts` (`ResearchRequest` with `outputSchema`,
   `ResearchReport` with `structured`, `ResearchJobRef`, `ResearchStatus`,
   `ResearchEvent`) + `research/DeepResearch.ts` (service tag). Reuse
   `Items.Annotation`, `Items.Usage`, `StructuredFormat`. Include the shared job/poll
   helper (see open questions; Effect gives us most of it, below). No provider yet.
2. **Exa `Research`.** Reference implementation: an existing package, exact
   create-task + poll shape, exercises both prose and `outputSchema` structured
   paths. Codec-level tests through the real decode path (per the meaningful-tests
   rule): decode a completed task into a `ResearchReport`, assert citations map to
   `Items.UrlCitation` and the structured payload decodes against the schema.
3. **Perplexity `Research`.** Second async job (prose report), confirms the shape
   generalizes past Exa.
4. **Recipe `deep-research`.** Exa + Perplexity first; add providers as they land.
5. **OpenAI `Research`.** Reuses the Responses codec; adds `background` + poll +
   annotation mapping + cancel.
6. **Gemini `Research`.** Thin Interactions slice; verify citation shape against
   live docs first. **Jina `Research`** alongside, as the sync-streaming variant that
   validates the transport-agnostic `research`.
7. **Docs.** Usage-POV `docs/language-models/deep-research.md`: "submit a question,
   get a cited report; it runs for minutes server-side." No wire internals, no
   provider comparison.

## Out of scope

- **Anthropic / xAI deep research.** Tool-augmented chat, not a hosted job. If
  wanted, a client recipe over `Loop` + `web_search`, not a `DeepResearch` provider.
- **Provider-hosted conversational runtimes** (Gemini Interactions general
  conversations, Anthropic Managed Agents, Mistral Conversations, OpenAI
  Conversations). Deliberately excluded here; see `native-agent.md` if that is ever
  revisited. `DeepResearch` uses only the research slice of those endpoints.
- **Webhooks** (OpenAI background completion), **file_search / MCP data sources**,
  **domain/search-mode scoping**, **structured report schemas**. Provider-typed or
  later; the common interface is question-in / cited-report-out.

## Open questions

- **Naming.** `DeepResearch` vs `Research` vs `ResearchAgent`. Pick before Phase 1;
  it names the tag, the module, the recipe.
- **A shared `Job<A>` primitive?** Effect already supplies the poll engine
  (`Effect.repeat` + `Schedule` + `Effect.onInterrupt` + `Effect.timeoutFail`), so
  this is not "build a poll loop," it is "wrap the three provider ops
  (`submitFn` / `statusFn` / `reportFn` / `cancelFn`) once and let Effect drive the
  cadence." Worth the small generic wrapper in `research/` (or a shared `job/`)
  rather than repeating the same `Effect.repeat({ schedule, until })` in each
  adapter? Leaning yes: identical shape three-plus times, and a future async
  capability (batch inference, video gen) reuses the same wrapper. The wrapper is
  ~15 lines because the hard part is a library primitive, not ours.
- **`effort` fidelity.** It maps to three different knobs (reasoning_effort / agent
  variant / model + max_tool_calls). Is a 3-level hint enough, or do callers need
  the provider-native knob? Leaning hint-plus-`model`-override, provider-typed for
  the rest, per "don't unify what isn't unified."
- **`research` interruption semantics.** OpenAI/Gemini cancel cleanly; Perplexity
  cannot (server job runs on). Document that interrupting Perplexity `research`
  abandons a job that keeps billing. Acceptable, or surface a warning?
- **`researchStream` where the job is poll-only.** Perplexity's async job has no
  event stream (only the sync endpoint streams). Emit synthesized progress from
  polling (`status` transitions), fall back to sync streaming, or omit
  `researchStream` from the Perplexity tag? Leaning synthesized-from-poll so the
  method exists uniformly.
- **Report shape.** Flat `{ text, citations }` now. Deep-research reports have
  structure (sections, tables, generated charts as images). Keep flat and let the
  caller parse, or model sections? Leaning flat for v1.

---

# Appendix A: Unified citation and streaming model

> Added after a July 2026 wire survey (raw notes in
> `plans/citation-model-research/`). This appendix supersedes the Phase-1
> `ResearchEvent` / `ResearchReport` sketch above where they conflict: it makes
> citations a first-class, streamable, provider-agnostic type shared by
> `LanguageModel` (with native web search), `DeepResearch`, and `WebSearch`,
> instead of a deep-research-only afterthought that only OpenAI populates.

## A.1 The problem this solves

Three surfaces in the repo touch "sources", and today they do not agree:

- **`LanguageModel` + a native web-search `ProviderTool`.** Only OpenAI
  Responses citations survive, and only as `OutputText.annotations` on the
  terminal `Turn`. Anthropic and Gemini grounding are decoded to nothing. The
  `web_search_call` item is dropped. `TurnEvent` has no citation event and no
  search-lifecycle event, so citations never stream: they appear all at once
  inside `TurnComplete.turn`.
- **`WebSearch`.** `SearchResult` is a flat `{ url, title?, snippet?, ... }`
  ranked list. It never produces an `Items.Annotation`; `WebSearchTool`
  flattens results to a numbered string for the model to read.
- **`DeepResearch` (this plan).** Wanted to reuse `Items.Annotation` and carry
  citations only in the terminal `Report`.

So a caller gets citations in three incompatible ways, and only one provider
actually delivers them. The consolidation goal: **one citation type, one
streaming surface, populated by every provider that can, streamed where the
provider streams and bundled where it does not.**

## A.2 What the wire actually looks like (survey summary)

Full matrix in `plans/citation-model-research/04-wire-all-providers-matrix.md`.
Two invariants across every provider that emits sources: **`url` and `title`
are the only universal fields**; everything else is optional. Answer-to-source
linking splits into three styles:

| Style | How a claim links to a source | Providers |
|---|---|---|
| **char/byte span** | `{start, end}` offsets into the answer text, each mapped to one or more sources | OpenAI `url_citation`, Gemini `groundingSupports.segment` (byte) + `groundingChunkIndices`, Gemini-Interactions (char), Cohere `{start,end}`, xAI annotations, Bedrock `span` |
| **quote-anchored** (a span sub-style) | no offsets, but an exact `cited_text` / `exactQuote` you can string-match to locate | Anthropic (per-block `cited_text`), Jina DeepSearch |
| **inline marker** | prose contains `[n]` / `[[n]](url)` indexing 1-based into an ordered source list | Perplexity, Kagi FastGPT, xAI (also) |
| **bare source list** | sources returned decoupled from prose (or no prose) | Exa, Tavily, Linkup, Brave, You.com, Firecrawl, SerpAPI, Mistral (interleaved chunks) |

Two more axes that drive the streaming design:

- **Incremental vs bundled citations.** Only **OpenAI** and **Anthropic** emit
  citations incrementally (`response.output_text.annotation.added`,
  `citations_delta`). **Gemini** and **Perplexity** deliver them only in the
  final chunk.
- **Search-progress events.** Only **OpenAI** (and Gemini-Interactions) emit a
  real search lifecycle (`web_search_call.in_progress/searching/completed`,
  with `action: search | open_page | find_in_page`). Anthropic surfaces search
  as content blocks; Gemini-classic and Perplexity surface nothing.
- **One span, many sources.** Gemini `groundingChunkIndices[]`, Cohere
  `sources[]`, and Anthropic per-block citations all attach **multiple** sources
  to a single answer span. Today's one-`url`-per-`UrlCitation` shape cannot
  represent that without duplicating the span.

## A.3 The citation data model

Separate the **source** (a document that exists) from the **span** (a region of
the answer that a set of sources supports). This is the one shape that
normalizes all four styles, and it is the only way to represent many-sources-
per-claim without lossy duplication.

```ts
// domain/Citation.ts

/** A document the model consulted. `url` + `title` are the only near-universal
 *  fields; everything else is best-effort. `raw` round-trips provider-opaque
 *  tokens (Anthropic `encrypted_index`, Gemini chunk handle, Cohere doc id). */
export type Source = {
  readonly url: string
  readonly title?: string
  readonly snippet?: string            // source-side excerpt / cited_text / content
  readonly publishedDate?: DateTime.DateTime
  readonly sourceType?: "web" | "x" | "news" | "file" | "document" | (string & {})
  readonly raw?: unknown
}

/** Where in the answer a claim is grounded, and which sources ground it.
 *  `sourceRefs` indexes into the sibling `sources` array (many-to-one). */
export type CitationSpan =
  | { readonly kind: "char"; readonly start: number; readonly end: number
      readonly unit: "char" | "byte"; readonly sourceRefs: ReadonlyArray<number>
      readonly confidence?: number }        // OpenAI, Gemini, Cohere, xAI, Bedrock
  | { readonly kind: "quote"; readonly text: string
      readonly sourceRefs: ReadonlyArray<number> }   // Anthropic, Jina DeepSearch
  | { readonly kind: "marker"; readonly ordinal: number
      readonly sourceRefs: ReadonlyArray<number> }   // Perplexity, Kagi
  | { readonly kind: "none"; readonly sourceRefs: ReadonlyArray<number> } // bare list

/** The grounding for one piece of generated text. */
export type Citations = {
  readonly sources: ReadonlyArray<Source>
  readonly spans: ReadonlyArray<CitationSpan>
}
```

**How the legacy `Items.Annotation` fits.** Today's `UrlCitation`
(`{type, url, title, start_index, end_index}`) is exactly the degenerate case
of this model: one `char` span with one source and its url/title inlined. Two
adoption paths:

1. **Evolve `Items.Annotation` minimally now, full model later.** Keep the flat
   `Annotation` array on `OutputText`, but make `start_index`/`end_index`
   optional and add optional `cited_text` + `marker`. This is a small,
   backward-compatible change that lets Anthropic and Perplexity populate
   annotations at all. It loses many-sources-per-span (you emit N annotations
   for one multi-source claim). Good enough for v1 of everything.
2. **Introduce `Citations` as the canonical structured form.** `OutputText`
   grows an optional `citations?: Citations` alongside the legacy flat
   `annotations`, and the assembled `Turn` is the place the structured form
   lives. Adapters that can (Gemini, Cohere, Anthropic) fill `citations`;
   simple ones fill `annotations`; a helper derives one from the other.

**Recommendation:** ship path 1 for the first providers (it unblocks
`DeepResearch` and native-grounding immediately with the least churn), and land
path 2 as the enrichment step when the first many-sources-per-span provider
(Gemini grounding, Cohere) gets a real decoder. Do not fork a parallel citation
type; `Citations` is the superset and `Annotation` is its flattened view.

## A.4 The streaming model: extend `TurnEvent`, do not fork it

Deep research on OpenAI **is** a Responses turn with `background: true`; it
emits the same SSE family the normal turn does. So the streaming answer to
"should the output be `TurnEvent`?" is **yes**: `ResearchEvent` collapses into
`TurnEvent`, and the two members that are missing today are added to
`TurnEvent` itself, which is exactly what plain `LanguageModel` + native search
also needs.

```ts
// added to the existing TurnEvent enum in domain/Turn.ts
WebSearchCall: {
  readonly status: "started" | "searching" | "completed"
  readonly query?: string
  readonly action?: "search" | "open_page" | "find_in_page"
}
CitationAdded: { readonly citation: Items.Annotation }  // or Citation, per A.3 path
```

Semantics:

- **`CitationAdded`** is emitted incrementally by providers that stream
  citations (OpenAI `annotation.added`, Anthropic `citations_delta`). Providers
  that bundle (Gemini, Perplexity) emit **no** `CitationAdded`; their citations
  still arrive on the terminal `TurnComplete.turn` (attached to the assembled
  `OutputText`). Consumers therefore read citations two ways uniformly: live via
  `CitationAdded`, or from the final `Turn`. A consumer that only cares about
  the final set just reads `TurnComplete`.
- **`WebSearchCall`** gives the "searching: ..." progress the plan wanted
  (`SearchStarted`), generalized to the full lifecycle and reused by
  `LanguageModel`. Poll-only research providers (Perplexity, Exa) synthesize
  `WebSearchCall { status }` from job-status transitions.
- **Terminal.** `TurnComplete` already carries the assembled `Turn` (items +
  usage + stop_reason). `DeepResearch`'s `ResearchReport` becomes a thin
  **projection** of that `Turn`: `text = Turn.assistantText`, `citations =` all
  annotations across its `OutputText` blocks, `usage = turn.usage`,
  `structured =` decoded from the text via the provider-typed `outputSchema`
  (the same `Turn.decodeStructured` path structured output already uses). So
  `ResearchReport` stops being a bespoke shape and is derived, and `ResearchEvent`
  disappears.

This is the crux of the consolidation: **one event stream type (`TurnEvent`),
one terminal (`TurnComplete.turn`), one citation type**, whether the turn came
from `LanguageModel.streamTurn`, a native-grounding turn, or
`DeepResearch.researchStream`.

Blast radius, stated honestly: adding to `TurnEvent` and evolving
`Items.Annotation` are **core changes shared with `LanguageModel`**, and they
imply new decode paths in the Responses / Anthropic / Google codecs (which today
decode none of this). That is a separate workstream from "add the `DeepResearch`
tag", and it is the right place for the native-grounding citation payoff to
actually land. `DeepResearch` is the forcing function, not the sole beneficiary.

### A.4.1 Why not type-gate these events to "a web-search tool is present"

A tempting refinement: make `WebSearchCall` / `CitationAdded` appear in the event
type only when the request carries a web-search `ProviderTool`, and be absent
otherwise. It is technically possible. `Toolkit<Tools>` preserves each tool as a
named entry, and the repo already inspects that at the type level (`ToolkitR` /
`ToolkitE` in `tool/Toolkit.ts`). A conditional `HasProviderWebSearch<T>` plus a
generic `CommonRequest` threaded into `streamTurn` would do it.

We deliberately do **not**, for three reasons:

- **Viral.** `CommonRequest.tools` is the wide `Toolkit` today and `streamTurn`
  does not thread toolkit types at all. Gating makes every request generic and
  forces inference through every call site.
- **Inconsistent with `TurnEvent`'s existing conditional members.**
  `RefusalDelta`, `ToolCallStart`, `UsageUpdate` all fire only sometimes and none
  are type-gated by input; they are members of one flat union that consumers
  match with a default. `WebSearchCall` / `CitationAdded` are the same kind.
- **Wrong predicate.** Citations also come from `file_search`, and deep-research
  models always search with no tool in the request, so "web-search tool present"
  both over- and under-approximates when the events can fire.

So they are always-present members of the flat `TurnEvent` union; they simply do
not fire without grounding. (If scoping is ever wanted without input-conditional
inference, a wider alias `GroundedTurnEvent = TurnEvent | WebSearchCall |
CitationAdded` used only where grounding is guaranteed is the pragmatic fallback,
but it re-splits the type we set out to consolidate.)

## A.5 Three transports, one capability, two markers

Deep research does not arrive over one transport. There are three, and they
differ in what the *caller* can do, not just in wire mechanics:

| # | transport | providers | detachable job | real live event stream |
|---|---|---|---|---|
| 1 | background job + separate live-stream endpoint | OpenAI, Gemini (Interactions) | yes | yes (SSE, resumable) |
| 2 | sync job, hold the connection | Jina DeepSearch | no (no job id exists) | yes (SSE) |
| 3 | background job + periodic poll | Perplexity, Exa | yes | no (poll-only) |

Two orthogonal axes fall out, and they split the providers *differently*:

- **Detachable job** (`submit` / `status` / `collect` / `cancel` by a durable
  ref): transports 1 and 3. Jina has no server-side job to detach from.
- **Real live stream** (incremental text / citation / search events): transports
  1 and 2. Perplexity / Exa can only synthesize progress from polling.

Because one axis cannot tell Jina (stream, no job) from Perplexity (job, no
stream) apart, both must be represented. Neither extreme works: "three separate
capabilities" fragments the universal `research` core and the shared report /
citation model, killing provider-portable code; "one fat interface" lies, since
`collect` on Jina or a real `researchStream` on Perplexity would compile and then
fail at runtime.

Use the repo's existing capability-marker pattern (`SttStreaming`,
`MusicInteractiveSession`): one capability, a universal core, and phantom `void`
markers gating the transport-dependent methods.

```ts
// Universal core — every deep-research provider ships this.
research: (request: ResearchRequest) => Effect<ResearchReport, AiError>

// Detachable background job. Providers 1 & 3.
class ResearchJob extends Context.Service<ResearchJob, void>()(
  "@betalyra/effect-uai/capability/ResearchJob",
) {}

// Real live progress stream. Providers 1 & 2.
class ResearchStreaming extends Context.Service<ResearchStreaming, void>()(
  "@betalyra/effect-uai/capability/ResearchStreaming",
) {}
```

Method-to-marker gating captures the matrix exactly:

| method | markers required in `R` | providers |
|---|---|---|
| `research(request)` | none (universal) | all five |
| `researchStream(request)` | `ResearchStreaming` | OpenAI, Gemini, Jina |
| `submit` / `status` / `collect` / `cancel` `(ref)` | `ResearchJob` | OpenAI, Gemini, Perplexity, Exa |
| `streamFrom(ref)` | `ResearchJob` + `ResearchStreaming` | OpenAI, Gemini |

`streamFrom(ref)` is the transport-1 move (attach a live stream to an
already-detached job) and correctly needs both markers. Jina's
`researchStream(request)` opens its sync socket directly (no ref, no `submit`).
Calling `researchStream` on Perplexity / Exa is a **compile error**, not a
degraded synthesized stream. Each provider registers its markers alongside its
layer, exactly like the STT realtime layer (`Layer.succeed(SttStreaming, void 0)`
inside `Layer.mergeAll`):

```ts
Layer.mergeAll(
  Layer.effect(OpenAiDeepResearch, make(cfg)),   // provider-typed tag
  Layer.effect(DeepResearch, generic(cfg)),        // generic tag
  Layer.succeed(ResearchJob, void 0),              // this provider is detachable
  Layer.succeed(ResearchStreaming, void 0),        // and streams live
)
```

Top-level helpers thread the markers into `R` the same way
`Transcriber.streamTranscriptionFrom` requires `SttStreaming`.

## A.6 `WebSearch` stays distinct, with a bridge

`SearchResult` and a citation are different concepts, and merging them would be
"unifying what is not unified":

- A **`SearchResult`** is a *candidate source as data*: a ranked hit you got
  back from a search API, independent of any answer.
- A **citation** is *a source the model actually used to ground a specific
  span* of generated text.

Keep `WebSearch.SearchResult` as-is. Add a one-way bridge for callers who want
to present search hits as sources:

```ts
// WebSearch.ts
export const toSource = (r: SearchResult): Source => ({
  url: r.url, title: r.title, snippet: r.snippet,
  publishedDate: r.publishedDate, sourceType: "web", raw: r.raw,
})
```

No `Citations` (no spans) comes out of a bare search: search results are
`sources` with no answer to anchor to. That is the honest shape.

Related gap, noted so it is not lost: the Jina provider today ships `JinaReader`
(`WebRead`) and `JinaEmbedding` (`EmbeddingModel`) but not its search index. A
**`JinaSearch`** module wrapping `s.jina.ai` onto the existing `WebSearch`
capability is a small, self-contained, orthogonal follow-up. Add on demand.

## A.7 The job `Ref` at the call site

`TurnEvent` stays pure (no job ref inside it, since `LanguageModel` shares the
type and has no job). The ref comes from `submit` (gated by `ResearchJob`), and
the convenience methods are symmetric wrappers over it:

```
research(request)        = submit(request) >>= (ref) => collect(ref)      [onInterrupt: cancel]
researchStream(request)  = submit(request) >>= (ref) => streamFrom(ref)   [scoped: cancel]
```

You do **not** need an Effect `Ref` for the happy path: just bind the value. A
`Ref` (or persistence) earns its place only when a *different* fiber needs the
handle, or you want to survive a restart. `ResearchJobRef` is deliberately plain
serializable data (`{ _tag, provider, id }`), so restart-survival is persistence,
not an in-memory `Ref`.

```ts
// 1) Simplest — no ref, no Ref. Interrupting this Effect cancels the job.
const report = yield* DeepResearch.research({ history })

// 2) "Cancel button" — a DIFFERENT fiber needs the handle -> in-memory Ref
const ref = yield* DeepResearch.submit({ history })          // needs ResearchJob
yield* Ref.set(activeJob, Option.some(ref))
const report = yield* DeepResearch.collect(ref)
// ...cancel-handler fiber:
yield* Ref.get(activeJob).pipe(
  Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: DeepResearch.cancel })),
)

// 3) Survive a restart — JobRef is just data, persist { provider, id }
const ref = yield* DeepResearch.submit({ history })
yield* saveJob(ref)                                          // to disk / db
// ...new process later:
const report = yield* loadJob().pipe(Effect.flatMap(DeepResearch.collect))
```

So a `Ref` is for cancel-from-elsewhere; detach-across-restart is persistence of
the plain id; the happy path needs neither. `submit` is the single source of the
ref for both the sync and streaming paths.

## A.8 Gemini's two citation surfaces (and why the LM provider does not switch)

Gemini exposes two shapes, and they must be handled separately:

- **`generateContent` grounding** (`groundingMetadata`: byte offsets +
  `groundingChunkIndices`, many-sources-per-span). The stable, full surface the
  current `LanguageModel` provider already uses.
- **Interactions API** (`google_search_call` items + Responses-style
  `url_citation` char annotations). Clean, maps onto the unified model with the
  same decoder as OpenAI, but flagged preview / converging.

Switching the whole `LanguageModel` provider to Interactions is **not**
transparent: it is a different endpoint with a different feature surface, and
betting the stable LM path on a preview API is the wrong trade. So:

- **Gemini deep-research module -> Interactions API** (as the main plan already
  routes it). Clean `url_citation`.
- **Gemini `LanguageModel` + native grounding -> stays `generateContent`**, and
  we decode its harder `groundingMetadata` into the same unified citation model.

Two Gemini surfaces, both normalized to one citation type. Revisit a full LM
switch only when Interactions reaches GA + parity.

## A.9 Revised shape and phasing

`ResearchRequest` stays minimal (only what every provider shares; `effort` /
`maxSearches` / `outputSchema` are provider-typed):

```ts
export type ResearchRequest = {
  readonly history: ReadonlyArray<Items.HistoryItem>   // reuse the LanguageModel input primitive
  readonly model?: string
}
```

`ResearchReport` is a projection of the terminal `Turn`, not a bespoke type:

```ts
export type ResearchReport = {
  readonly text: string
  readonly citations: ReadonlyArray<Items.Annotation>  // flattened view (A.3 path 1)
  readonly structured?: unknown                         // decoded via provider-typed outputSchema
  readonly usage?: Items.Usage
}
```

Full service surface (methods gated by the A.5 markers on the top-level helpers):

```ts
export type DeepResearchService = {
  readonly research:       (request: ResearchRequest) => Effect<ResearchReport, AiError>  // universal
  readonly researchStream: (request: ResearchRequest) => Stream<TurnEvent, AiError>       // ResearchStreaming
  readonly submit:         (request: ResearchRequest) => Effect<ResearchJobRef, AiError>  // ResearchJob
  readonly status:         (ref: ResearchJobRef)      => Effect<ResearchStatus, AiError>  // ResearchJob
  readonly collect:        (ref: ResearchJobRef)      => Effect<ResearchReport, AiError>  // ResearchJob
  readonly streamFrom:     (ref: ResearchJobRef)      => Stream<TurnEvent, AiError>       // ResearchJob + ResearchStreaming
  readonly cancel:         (ref: ResearchJobRef)      => Effect<void, AiError>            // ResearchJob
}
```

`ResearchEvent` is **removed**; both stream methods yield `TurnEvent`.
`ResearchJobRef` = `Job.JobRef`, `ResearchStatus` = `Job.JobStatus` (the generic
`job/Job.ts`, already written).

Phasing (each step independently landable; interleaves with the main plan's
provider phases):

1. **Core citation model.** `domain/Citation.ts` (`Source` / `CitationSpan` /
   `Citations`); evolve `Items.Annotation` per A.3 path 1 (optional span,
   `citedText`, `marker`), keeping the flat view as the degenerate case.
2. **Core streaming.** Add `WebSearchCall` + `CitationAdded` to `TurnEvent`.
   `job/Job.ts` (done).
3. **`DeepResearch` capability.** The tag + `ResearchJob` / `ResearchStreaming`
   markers + domain (`ResearchRequest` / `ResearchReport`). No provider yet.
4. **Responses codec.** Decode `web_search_call.*` and `annotation.added` into
   the new `TurnEvent` members; stop dropping the search item. Lights up
   native-grounding citations for plain `LanguageModel`, not just `DeepResearch`.
5. **Anthropic + Google codecs.** Decode `citations_delta` / `groundingMetadata`
   into `Annotation` (path 1), then `Citations` (A.3 path 2) when
   many-sources-per-span is worth it.
6. **Research providers** through the real codec, with tests (per the
   meaningful-tests rule): Exa (create-task + poll, structured path; `ResearchJob`)
   and Perplexity (async poll; `ResearchJob`) first, then OpenAI (Responses
   background + resume SSE; both markers), Gemini (Interactions; both markers),
   Jina (sync stream; `ResearchStreaming` only).
