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
```
