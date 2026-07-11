# Plan: `DeepResearch` capability

## Implementation status (2026-07)

The core capability and the first provider are **shipped and green** (workspace
typecheck passes; 433 tests pass). The authoritative design is **Appendix A**;
this section is what physically exists on disk.

**Shipped**

- **Generic job primitive** — `packages/core/src/job/Job.ts`. `JobRef<A>`
  (phantom-branded by result type so refs can't cross capabilities),
  `JobState<A>` tagged enum (`Pending` / `Running` / `Succeeded{result}` /
  `Failed{reason?,raw?}`), `JobOps<A>` (`submit` / `poll` / `cancel`), and
  `collect` / `run` driving a jittered poll loop bounded by a timeout. Effect
  ships no equivalent (`Resource` is an auto-refresh cache), so this is a thin
  wrapper over `Effect.repeat` + `Schedule` + `timeoutOrElse` + `onInterrupt`.
- **Citation model** — `packages/core/src/domain/Citation.ts` (`Source` /
  `CitationSpan` / `Citations`, the canonical form). `Items.UrlCitation` evolved
  to the flattened view (optional span + `cited_text` + `marker`).
- **Streaming** — `TurnEvent` gained `WebSearchCall` + `CitationAdded`;
  `Turn.citations(turn)` collects annotations. `ResearchEvent` was never added
  (removed from the design): the stream is `TurnEvent`, the result is a `Turn`.
- **`DeepResearch` capability** — `packages/core/src/research/DeepResearch.ts`.
  A marker-free job core (`submit` / `status` / `collect` / `streamFrom` /
  `cancel`); `research` / `researchStream` are derived. Providers build the
  service with the `fromJob` constructor, which supplies a synthesized
  `streamFrom` for poll-only jobs (see Appendix B, which supersedes A.5's
  two-marker split). `domain/Research.ts` holds `ResearchRequest`
  (`{ history, model? }`), `ResearchJobRef = Job.JobRef<Turn>`,
  `ResearchState = Job.JobState<Turn>`.
- **Responses codec** — decodes `response.web_search_call.*` → `WebSearchCall`
  and `response.output_text.annotation.added` → `CitationAdded`
  (`packages/providers/responses/src/streamEvents.ts`). Native-grounding
  citations now stream for plain `LanguageModel`, not just deep research. Covered
  by a real-decode-path test.
- **Perplexity `DeepResearch` (async reference)** —
  `packages/providers/perplexity/src/PerplexityDeepResearch.ts`. `/v1/async/sonar`
  submit + poll → `Turn` via `fromJob`; `search_results` → marker-anchored
  `url_citation` annotations. Poll-only, so `streamFrom` / `researchStream` are
  the synthesized default (leading search event + terminal report) and `cancel`
  fails `Unsupported` (no endpoint). Shared package `http.ts` for error mapping.
- **OpenAI `DeepResearch`** —
  `packages/providers/responses/src/OpenAIDeepResearch.ts`. `/responses` with
  `background: true` submit + poll → `Turn` via `fromJob`, with a real resumable
  SSE `streamFrom` (`?stream=true`) and a working `cancel`. Reuses the Responses
  codec (`turnFromCompleted`, `itemsToInput`) and the canonical `TurnEvent`
  projection.
- **`native-deep-research` recipe** — `recipes/native-deep-research/`. Streaming
  background run over the generic tag (`researchStream` → render live progress →
  print the cited report), portable across Perplexity + OpenAI (see Appendix B.7).

**Design decisions locked** (details in Appendix A)

- Input is `history: ReadonlyArray<HistoryItem>`, not `question: string`.
- Result is a `Turn` (projected via `Turn.assistantText` / `Turn.citations` /
  `Turn.decodeStructured`); there is no `ResearchReport`.
- Depth / search-cap / structured-output knobs are provider-typed, not on the
  common request.
- One capability, **no markers**: every provider is a job, streaming is universal
  (real or synthesized), and non-uniform knobs live on provider-typed tags
  (Appendix B supersedes A.5's two-marker split).
- `WebSearchCall` / `CitationAdded` are flat `TurnEvent` members, not
  input-type-gated.

**Not done (deliberately out of scope for this slice)**

- Anthropic + Google grounding decode into `Annotation` / `Citations` (A.9 step 5).
- The remaining providers: Gemini (Interactions), Jina (sync stream), Exa (now
  sync `/search?type=deep-reasoning`) — next up: Exa then Google.
- Provider-typed steering: Gemini collaborative `plan` / `refine` and the OpenAI
  `previousRef` follow-up handle (Appendix B.3).
- Perplexity `LanguageModel` + a shared OpenAI-compatible Chat Completions base
  (its own follow-up: `plans/openai-compatible-chat.md`).

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
> locked (per the verify-referenced-paths rule). The _shapes_ are solid; the
> _string literals_ and citation-object fields are the risk.

## Provider landscape

Researched July 2026. Two families ship a real deep-research API, and they share
one shape at the interface. **Two of them (Exa, Jina) are already effect-uai
providers** as web-search backends, so adding research there is a second module in
an existing package, not a new one.

### Family A: LLM-provider report writers (long prose + citations)

| Provider       | Endpoint                                  | Model / agent                               | Async model                                                     | Report + citations                                                                         |
| -------------- | ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **OpenAI**     | `POST /v1/responses`                      | `o3-deep-research`, `o4-mini-deep-research` | `background: true` → poll `GET /v1/responses/{id}` (or webhook) | `message` item; `content` text with `annotations[]` `{url, title, start_index, end_index}` |
| **Gemini**     | `POST /v1beta/interactions`               | `deep-research-preview-04-2026`, `-max-`    | `background: true` → poll `GET /v1beta/interactions/{id}`       | final `step` text; citation-object shape needs live-doc check                              |
| **Perplexity** | `POST /v1/async/sonar` (sync `/v1/sonar`) | `sonar-deep-research`                       | dedicated async endpoint → poll `GET /v1/async/sonar/{id}`      | `choices[0].message.content` + `citations[]` + `search_results[]`                          |
| **Parallel**   | Task API (`platform.parallel.ai`)         | processor tiers                             | async task → poll                                               | evidence-based outputs with per-output provenance                                          |
| **You.com**    | ARI (Advanced Research & Insights) API    | ARI                                         | async                                                           | cited report                                                                               |

### Family B: search-infra research (structured / precise, citation-grounded)

| Provider           | Endpoint                                              | Model                                                      | Async model                           | Report + citations                                                    |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| **Exa** (in repo)  | `POST` research create-task                           | `exa-research` tiers (`deep-lite`/`deep`/`deep-reasoning`) | **create task → poll `get_task(id)`** | **structured JSON against an `output_schema`, field-level citations** |
| **Jina** (in repo) | `POST https://deepsearch.jina.ai/v1/chat/completions` | `jina-deepsearch-v1`                                       | **sync streaming (SSE)**, no poll     | precise answer + citations, not long-form                             |
| **Valyu**          | deep research API                                     | -                                                          | async                                 | accuracy-first cited answer                                           |

The common shape across the async providers: **submit with a background/async
flag (or create a task), get a job id, poll for a terminal status, read one cited
result.** OpenAI/Gemini run it as a background turn of their hosted-agent runtime;
Perplexity/Parallel/You.com/Valyu are standalone async endpoints. **Perplexity is
the reference implementation** (dedicated `/v1/async/sonar` submit + poll maps 1:1
onto the interface) and shipped first. Note (verified 2026-07): **Exa deprecated
its async research task API** and now serves deep research as a _synchronous_
`/search?type=deep-reasoning` call, so Exa joins Jina as a sync (transport-2)
outlier, not an async job.

The **structured-output** split matters for the interface. Family A returns prose;
Exa (and optionally Parallel) returns typed JSON against a caller-supplied schema,
each field grounded by citations. That overlaps effect-uai's existing
`StructuredFormat` machinery, so the interface grows an optional `outputSchema`
(see below): omit it for a prose report, pass it for grounded structured data on
providers that support it.

### Not deep research (explicitly out)

- **Anthropic** and **xAI** ship only server-side search _tools_ (`web_search`;
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
  readonly citations: ReadonlyArray<Items.Annotation> // reuse the existing Annotation union
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
  | { readonly _tag: "ReasoningDelta"; readonly text: string } // "thought" / thinking summaries
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

### Exa (was the async reference; now a sync provider)

> **Superseded (verified 2026-07).** Exa **deprecated its `/research/v1`
> create-task + poll API on 2026-05-01**. Deep research is now a **synchronous**
> `POST /search` with `type: "deep-reasoning"` (optionally SSE-streamed with
> `stream: true`), not an async job. So Exa no longer exercises the
> `Job` / `submit` / `poll` / `collect` surface at all: it is a **transport-2
> (sync)** provider like Jina, not the async reference. **Perplexity became the
> async reference implementation and shipped first** (below). The original Exa
> async plan is kept here only as historical context.

When Exa is added, it is a sync `DeepResearch` module (`ResearchStreaming`
marker only, no `ResearchJob`): `research(request)` drains the `/search`
deep-reasoning result to a `Turn`; `researchStream` forwards the SSE variant.
The structured-output path (`type: "deep-reasoning"` + a schema) is a
provider-typed knob, surfaced via `Turn.decodeStructured`.

Historical (pre-deprecation) async shape, for reference:

- **submit:** create a research task with `{ instructions: question, output_schema? }`
  (`POST` on the research resource; SDK `research.create_task`). Returned a task id.
- **status / collect:** poll `get_task(id)` until `completed` / `failed`. Result
  was structured JSON with field-level citations, or prose.
- **effort:** `effort` → tier (`deep-lite` / `deep` / `deep-reasoning`) — these
  tiers now live on the sync `/search` `type` field.

### Perplexity (async reference implementation — SHIPPED)

The first `DeepResearch` provider, in
`packages/providers/perplexity/src/PerplexityDeepResearch.ts`. A plain async
REST job, no agent-runtime baggage. Wire verified against the live OpenAPI
2026-07. Ships the `ResearchJob` marker (detachable) but **not**
`ResearchStreaming` (poll-only).

- **submit:** `POST /v1/async/sonar` `{ request: { model: "sonar-deep-research",
messages, reasoning_effort? }, idempotency_key? }` → `{ id, status: "CREATED" }`.
- **status / collect (`poll`):** `GET /v1/async/sonar/{id}` → `{ status, response? }`;
  status enum is exactly `CREATED | IN_PROGRESS | COMPLETED | FAILED`, mapped onto
  `Job.JobState` (`Pending` / `Running` / `Succeeded` / `Failed`). On `COMPLETED`,
  the `Turn` is built from `response.choices[0].message.content`; citations from
  `response.search_results[]` (`{title, url, snippet}`) with the legacy
  `response.citations[]` URL list as fallback, each mapped to a `url_citation`
  annotation with a 1-based `marker` (Perplexity's `[n]` linking) and `cited_text`
  from the snippet.
- **effort:** provider-typed `reasoningEffort` (`minimal`/`low`/`medium`/`high`)
  on `PerplexityResearchRequest`, not the common request.
- **cancel:** no endpoint exists; `cancel` fails `AiError.Unsupported`.
  Interrupting `research` drops the client wait (the server job runs on).
- **researchStream / streamFrom:** the async job has no event stream, so both
  fail `AiError.Unsupported` and the `ResearchStreaming` marker is withheld
  (calling them against this Layer is a compile error). Provider-typed extras
  still off the interface: `search_mode`, `search_domain_filter`,
  `web_search_options`.
- Package: `PerplexityDeepResearch` in `@effect-uai/perplexity` (also a
  web-search provider). API-key auth, `Authorization: Bearer`. Shares a new
  `http.ts` (error mapping) with the package.

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
- **Different product framing:** optimized for a precise cited _answer_, not a
  long-form report. Document the expectation difference; still fits
  `ResearchReport` (`text` + `citations`).
- Package: a `Research` module in `@effect-uai/jina`. API-key auth.
- This is the provider that proves `research` must not _assume_ an async job: for
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

> **Superseded by Appendix A.9** (the authoritative phasing after the citation +
> streaming consolidation) and the status below. This original list predates the
> `Turn`-result / `JobState` / two-marker design and the Exa deprecation. Kept
> for history.
>
> **Status (2026-07):** Core capability, `Job` primitive, citation model,
> `TurnEvent` extension, Responses-codec streaming citations, and the
> **Perplexity `DeepResearch`** provider are all **shipped and green** (433
> tests). Perplexity, not Exa, is the async reference (Exa deprecated its async
> API). Remaining: Anthropic/Google grounding decode, OpenAI/Gemini/Jina/Exa
> providers, and the recipe.

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

| Style                                 | How a claim links to a source                                                       | Providers                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **char/byte span**                    | `{start, end}` offsets into the answer text, each mapped to one or more sources     | OpenAI `url_citation`, Gemini `groundingSupports.segment` (byte) + `groundingChunkIndices`, Gemini-Interactions (char), Cohere `{start,end}`, xAI annotations, Bedrock `span` |
| **quote-anchored** (a span sub-style) | no offsets, but an exact `cited_text` / `exactQuote` you can string-match to locate | Anthropic (per-block `cited_text`), Jina DeepSearch                                                                                                                           |
| **inline marker**                     | prose contains `[n]` / `[[n]](url)` indexing 1-based into an ordered source list    | Perplexity, Kagi FastGPT, xAI (also)                                                                                                                                          |
| **bare source list**                  | sources returned decoupled from prose (or no prose)                                 | Exa, Tavily, Linkup, Brave, You.com, Firecrawl, SerpAPI, Mistral (interleaved chunks)                                                                                         |

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
  readonly snippet?: string // source-side excerpt / cited_text / content
  readonly publishedDate?: DateTime.DateTime
  readonly sourceType?: "web" | "x" | "news" | "file" | "document" | (string & {})
  readonly raw?: unknown
}

/** Where in the answer a claim is grounded, and which sources ground it.
 *  `sourceRefs` indexes into the sibling `sources` array (many-to-one). */
export type CitationSpan =
  | {
      readonly kind: "char"
      readonly start: number
      readonly end: number
      readonly unit: "char" | "byte"
      readonly sourceRefs: ReadonlyArray<number>
      readonly confidence?: number
    } // OpenAI, Gemini, Cohere, xAI, Bedrock
  | { readonly kind: "quote"; readonly text: string; readonly sourceRefs: ReadonlyArray<number> } // Anthropic, Jina DeepSearch
  | {
      readonly kind: "marker"
      readonly ordinal: number
      readonly sourceRefs: ReadonlyArray<number>
    } // Perplexity, Kagi
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
  usage + stop_reason). The completed research result **is** that `Turn`: one
  assistant message with the report text and its citations on
  `OutputText.annotations`. There is no bespoke report type. Callers project it
  with `Turn.assistantText` (text), `Turn.citations` (all annotations across the
  `OutputText` blocks, a helper added for this), and `Turn.decodeStructured`
  (the provider-typed `outputSchema` path structured output already uses). Both
  `ResearchReport` and `ResearchEvent` disappear: the sync result is a `Turn` and
  the stream is `TurnEvent`.

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
differ in what the _caller_ can do, not just in wire mechanics:

| #   | transport                                      | providers                     | detachable job        | real live event stream |
| --- | ---------------------------------------------- | ----------------------------- | --------------------- | ---------------------- |
| 1   | background job + separate live-stream endpoint | OpenAI, Gemini (Interactions) | yes                   | yes (SSE, resumable)   |
| 2   | sync job, hold the connection                  | Jina DeepSearch               | no (no job id exists) | yes (SSE)              |
| 3   | background job + periodic poll                 | Perplexity, Exa               | yes                   | no (poll-only)         |

Two orthogonal axes fall out, and they split the providers _differently_:

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

| method                                             | markers required in `R`             | providers                       |
| -------------------------------------------------- | ----------------------------------- | ------------------------------- |
| `research(request)`                                | none (universal)                    | all five                        |
| `researchStream(request)`                          | `ResearchStreaming`                 | OpenAI, Gemini, Jina            |
| `submit` / `status` / `collect` / `cancel` `(ref)` | `ResearchJob`                       | OpenAI, Gemini, Perplexity, Exa |
| `streamFrom(ref)`                                  | `ResearchJob` + `ResearchStreaming` | OpenAI, Gemini                  |

`streamFrom(ref)` is the transport-1 move (attach a live stream to an
already-detached job) and correctly needs both markers. Jina's
`researchStream(request)` opens its sync socket directly (no ref, no `submit`).
Calling `researchStream` on Perplexity / Exa is a **compile error**, not a
degraded synthesized stream. Each provider registers its markers alongside its
layer, exactly like the STT realtime layer (`Layer.succeed(SttStreaming, void 0)`
inside `Layer.mergeAll`):

```ts
Layer.mergeAll(
  Layer.effect(OpenAiDeepResearch, make(cfg)), // provider-typed tag
  Layer.effect(DeepResearch, generic(cfg)), // generic tag
  Layer.succeed(ResearchJob, void 0), // this provider is detachable
  Layer.succeed(ResearchStreaming, void 0), // and streams live
)
```

Top-level helpers thread the markers into `R` the same way
`Transcriber.streamTranscriptionFrom` requires `SttStreaming`.

## A.6 `WebSearch` stays distinct, with a bridge

`SearchResult` and a citation are different concepts, and merging them would be
"unifying what is not unified":

- A **`SearchResult`** is a _candidate source as data_: a ranked hit you got
  back from a search API, independent of any answer.
- A **citation** is _a source the model actually used to ground a specific
  span_ of generated text.

Keep `WebSearch.SearchResult` as-is. Add a one-way bridge for callers who want
to present search hits as sources:

```ts
// WebSearch.ts
export const toSource = (r: SearchResult): Source => ({
  url: r.url,
  title: r.title,
  snippet: r.snippet,
  publishedDate: r.publishedDate,
  sourceType: "web",
  raw: r.raw,
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
`Ref` (or persistence) earns its place only when a _different_ fiber needs the
handle, or you want to survive a restart. `ResearchJobRef` is deliberately plain
serializable data (`{ _tag, provider, id }`), so restart-survival is persistence,
not an in-memory `Ref`.

```ts
// 1) Simplest — no ref, no Ref. Interrupting this Effect cancels the job.
const turn = yield * DeepResearch.research({ history }) // returns a Turn
const text = Turn.assistantText(turn) // + Turn.citations(turn)

// 2) "Cancel button" — a DIFFERENT fiber needs the handle -> in-memory Ref
const ref = yield * DeepResearch.submit({ history }) // needs ResearchJob
yield * Ref.set(activeJob, Option.some(ref))
const turn = yield * DeepResearch.collect(ref)
// ...cancel-handler fiber:
yield *
  Ref.get(activeJob).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: DeepResearch.cancel })),
  )

// 3) Survive a restart — JobRef is just data, persist { provider, id }
const ref = yield * DeepResearch.submit({ history })
yield * saveJob(ref) // to disk / db
// ...new process later:
const turn = yield * loadJob().pipe(Effect.flatMap(DeepResearch.collect))
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
  readonly history: ReadonlyArray<Items.HistoryItem> // reuse the LanguageModel input primitive
  readonly model?: string
}
```

The completed result is a `Turn`, not a bespoke report type. Project it with
`Turn.assistantText` / `Turn.citations` / `Turn.decodeStructured`.

Full service surface (methods gated by the A.5 markers on the top-level helpers):

```ts
export type DeepResearchService = {
  readonly research: (request: ResearchRequest) => Effect<Turn, AiError> // universal
  readonly researchStream: (request: ResearchRequest) => Stream<TurnEvent, AiError> // ResearchStreaming
  readonly submit: (request: ResearchRequest) => Effect<ResearchJobRef, AiError> // ResearchJob
  readonly status: (ref: ResearchJobRef) => Effect<ResearchState, AiError> // ResearchJob
  readonly collect: (ref: ResearchJobRef) => Effect<Turn, AiError> // ResearchJob
  readonly streamFrom: (ref: ResearchJobRef) => Stream<TurnEvent, AiError> // ResearchJob + ResearchStreaming
  readonly cancel: (ref: ResearchJobRef) => Effect<void, AiError> // ResearchJob
}
```

`ResearchReport` and `ResearchEvent` are **removed**: the sync result is a
`Turn`, the stream is `TurnEvent`. The job types are generic and branded by
their result:

```ts
// job/Job.ts (written)
export type JobRef<A> = {
  readonly _tag: "JobRef"
  readonly provider: string
  readonly id: string /* + phantom A */
}
export type JobState<A> =
  | { _tag: "Pending" }
  | { _tag: "Running" }
  | { _tag: "Succeeded"; result: A }
  | { _tag: "Failed"; reason?: string; raw?: unknown }
export type JobOps<A> = {
  submit: Effect<JobRef<A>, AiError>
  poll: (ref: JobRef<A>) => Effect<JobState<A>, AiError>
  cancel: (ref: JobRef<A>) => Effect<void, AiError>
}
// domain/Research.ts
export type ResearchJobRef = Job.JobRef<Turn>
export type ResearchState = Job.JobState<Turn>
```

`JobRef<A>` is phantom-branded by its result type, so a ref cannot be crossed
between capabilities. `poll` returns the full `JobState` (status + result in one
fetch, matching the wire), replacing the earlier separate `status` + `report`.

Phasing (each step independently landable; interleaves with the main plan's
provider phases):

1. **Core citation model** (done). `domain/Citation.ts` (`Source` /
   `CitationSpan` / `Citations`); `Items.Annotation` evolved per A.3 path 1
   (optional span, `cited_text`, `marker`), the flat view as the degenerate case.
2. **Core streaming** (done). `WebSearchCall` + `CitationAdded` on `TurnEvent`,
   `Turn.citations` helper, `job/Job.ts`.
3. **`DeepResearch` capability** (done). The tag + `ResearchJob` /
   `ResearchStreaming` markers + domain (`ResearchRequest`; result is `Turn`).
   No provider yet.
4. **Responses codec.** Decode `web_search_call.*` and `annotation.added` into
   the new `TurnEvent` members; stop dropping the search item. Lights up
   native-grounding citations for plain `LanguageModel`, not just `DeepResearch`.
5. **Anthropic + Google codecs.** Decode `citations_delta` / `groundingMetadata`
   into `Annotation` (path 1), then `Citations` (A.3 path 2) when
   many-sources-per-span is worth it.
6. **Research providers** through the real codec: **Perplexity** (async poll;
   `ResearchJob`) shipped first as the async reference. Then OpenAI (Responses
   background + resume SSE; both markers), Gemini (Interactions; both markers),
   and the sync (transport-2) providers Jina and Exa (`/search?type=deep-reasoning`
   after its async deprecation), both `ResearchStreaming` only.

---

# Appendix B: Streaming, background jobs, attach/detach, and steering a running agent

> Added 2026-07 after a second design pass, prompted by two observations: a run
> lasts 5 to 30 minutes, so the primary use case is a **background job you watch
> live and can walk away from**, not a blocking call; and we never checked
> whether you can _talk to_ a research agent while it runs. This appendix
> refines A.5's "three transports, two markers" split. Where they conflict, this
> appendix wins: the sync providers become **jobs** too (wrapped client-side),
> streaming is the easy default everywhere, and steering is modeled as a
> conversation at turn boundaries because that is the only thing the wire
> supports.

## B.1 The use case that should be the easy one

Blocking `research()` is the wrong default for a 30-minute job. What a developer
reaches for first should be:

1. **start** a job and get a handle back immediately,
2. **stream** what it is doing live (pages opened, searches issued, reasoning
   summaries, text as it lands) so a long run visibly makes progress,
3. optionally **detach** (stop watching, do other work) and **re-attach** later
   to the same run.

So the base primitives are `submit -> ref` and `streamFrom(ref) -> Stream<TurnEvent>`.
The blocking `research()` (submit + poll to the terminal `Turn`) is a convenience
wrapper on top, not the foundation. The docs should lead with the streaming
background path and mention `research()` second, the reverse of A.9's emphasis.

## B.2 Can you message a running agent? Provider survey (verified 2026-07)

The empirical question, answered against live docs rather than assumed. The
columns that matter for a long run: can you inject a message **mid-execution**,
is there a **pre-run planning** exchange, a **post-completion follow-up**, and is
the progress stream **resumable** (the wire-level attach/detach).

| Provider                                     | mid-run message                   | pre-run planning                                                                                                           | post-run follow-up                                                     | resumable stream                                                          |
| -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **OpenAI** (`o3`/`o4-mini-deep-research`)    | no                                | no (front-load the prompt)                                                                                                 | `previous_response_id`                                                 | yes: `background+stream`, resume via `starting_after` + `sequence_number` |
| **Gemini** (`deep-research-preview-04-2026`) | **no** (explicit)                 | **yes**: `collaborative_planning:true` + `previous_interaction_id`, refine then commit with `collaborative_planning:false` | `previous_interaction_id` (switches to a normal model)                 | yes: `stream=true` + `last_event_id`                                      |
| **Perplexity** (`sonar-deep-research`)       | no                                | no                                                                                                                         | no (async job is one-shot; the sync Sonar chat is a different surface) | no (poll-only)                                                            |
| **Jina / Exa** (sync)                        | no                                | no                                                                                                                         | no                                                                     | the one live connection is the stream; nothing to resume                  |
| **Anthropic**                                | n/a (no deep-research job at all) | n/a                                                                                                                        | n/a                                                                    | n/a                                                                       |

**Anthropic re-confirmed 2026-07.** There is still no first-party deep-research
endpoint: deep research on Claude is client-built (the `web_search` server tool
inside the Messages loop, multi-agent orchestration, MCP research servers, or the
Claude Code `/deep-research` skill). "Managed Agents" is a general stateful agent
runtime, not a report-plus-citations job contract. So Anthropic stays out of the
`DeepResearch` provider set, now doubly so: it ships a client-side research
_skill_, which is exactly the "client recipe over `Loop` + search, not a provider"
shape the main plan predicted.

**The invariant across every provider: no mid-execution injection.** Once a job
commits, it runs to completion untouched. The steering that exists is bracketed
to the two boundaries: _before_ the run (Gemini collaborative planning) and
_after_ it (`previous_*_id` follow-up). Both are turns in a conversation, not a
live side-channel.

Sources: OpenAI [background guide](https://developers.openai.com/api/docs/guides/background)
and [deep research guide](https://developers.openai.com/api/docs/guides/deep-research);
Gemini [Interactions deep research](https://ai.google.dev/gemini-api/docs/interactions/deep-research);
Perplexity [async announcement](https://community.perplexity.ai/t/sonar-deep-research-async-mode-and-reasoning-effort-now-live/4736);
Anthropic [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
and [three ways to build deep research with Claude](https://paddo.dev/blog/three-ways-deep-research-claude/).

## B.3 Consequence: steering is a research conversation, not a live channel

Because steering only happens at turn boundaries, it maps onto machinery the
interface already has: `ResearchRequest.history`. A follow-up is a new research
request whose history includes the prior report (the completed `Turn`'s items).
Two provider mechanisms fold in as **optional, marker-gated** methods:

- **Pre-execution planning** (Gemini `collaborative_planning`). A short multi-turn
  exchange that produces a research _plan_ the caller can inspect and refine
  before the expensive run commits. Model it as `plan(request) -> Turn` (the plan
  is just a `Turn` you can show or edit) plus a `refine(planRef, note)` loop, then
  `submit` commits it. Providers without planning skip straight to `submit`.
- **Post-completion follow-up** (`previous_interaction_id` / `previous_response_id`).
  Threading a finished job's server-side context into the next request. Providers
  with a native handle round-trip it (carried on the completed `Turn`'s
  `providerData` or the ref); providers without one just resend `history`. Either
  way the caller sees "continue from that report."

**None of these belongs on the generic interface.** Applying "don't unify what
isn't unified":

- **Planning (`plan` / `refine`)** is Gemini-only (n=1) with Gemini-specific
  semantics (the `collaborative_planning` flag must be flipped false on the final
  turn). It lives on the provider-typed `GoogleDeepResearch` tag, not the generic
  capability. Promote to a shared marker only once a second provider ships it.
- **Follow-up** needs no method at all: "continue from that report" is generically
  `submit({ history: [...priorTurn.items, next] })`. The native handle
  (`previous_response_id` / `previous_interaction_id`) is only an optimization, so
  it rides as an optional `previousRef` on the provider-typed request, not a
  generic `followUp`.
- **Mid-run `steer`** ships nowhere, so it gets no generic slot. If it ever
  appears it appears on one provider first, which makes it provider-typed anyway;
  promote later. YAGNI beats a design slot for a non-existent feature.

So the generic `DeepResearch` capability grows no steering surface at all: steering
stays entirely provider-typed until a second provider forces a shared shape.

## B.4 One job model: wrap the sync providers as virtual jobs

A.5 modeled Jina/Exa as a separate "transport 2" that has no job, which forced
`submit`/`collect` to be a compile error there and split the interface. Reverse
it: give the sync providers a **client-side virtual job** so _every_ provider is
a job and the surface is uniform. `submit` forks a daemon fiber that runs the
sync streaming call, republishes its events to a `PubSub<TurnEvent>`, and resolves
a `Deferred<Turn>` at the end; the `JobRef` points at an in-process registry entry
instead of a server id. Then `submit` / `status` / `collect` / `streamFrom` /
`cancel` are **universal**.

This has one honest cost, but it is **documentation, not a marker or a service
concern**: a virtual job lives only as long as the process (its fiber holds the
connection), so its ref cannot be collected from a fresh process. a server-backed
ref can. This is not something the type system can gate: `collect` / `streamFrom`
are used _in-process by every provider_ on the happy path, so you cannot make them
require a "durable" marker without breaking the common case, and the types cannot
tell "same process" from "different process" anyway. And persistence itself is
trivially the developer's job: the ref is plain `{ _tag, provider, id }`, dropped
into a file / Redis / Postgres in whatever store they already run. So we ship
**no** `DurableJob` marker. we document, per provider, whether a persisted ref
survives a restart (server-backed: OpenAI, Gemini, Perplexity. virtual: Jina, Exa).

Streaming likewise becomes universal. Real event stream where the provider streams
(OpenAI/Gemini SSE, or the sync provider's own SSE inside the virtual job);
**synthesized** progress where it does not (Perplexity): a leading
`WebSearchCall{status:"searching"}` then the terminal `TurnComplete` off the poll
loop. The virtual-job fiber (and, for a plain poll-only provider, the `fromJob`
default `streamFrom`) is the natural home for synthesizing.

Trade stated honestly: A.5 deliberately compile-errored `researchStream` on
poll-only providers so the type could not "lie" about live progress. Making
streaming universal reverses that call. The justification is B.1: a uniformly easy
streaming default is worth more than the compile-time gate, and synthesized
progress is honest low-fidelity progress, not a fabrication, **as long as it is
labeled** (optionally a `synthesized: true` field on those events). Net marker
change from A.5: drop `ResearchJob` and `ResearchStreaming` (both universal now)
and add no replacement. The generic interface ends up marker-free (B.6).

## B.5 Attach / detach with Effect: what is interface, what is recipe

An in-process running job is a fiber writing to a `PubSub<TurnEvent>` with a
`Deferred<Turn>` for the terminal result. Effect already supplies every piece:

- **attach** = `Stream.fromPubSub` (a bounded replay of buffered events, then the
  live tail). `PubSub` fans out, so several attachers can watch one run.
- **detach** = interrupt your consuming fiber. The job fiber is a _daemon_ (forked
  into a job-scoped `Scope`, not the caller's), so it keeps running.
- **re-attach** = subscribe again: replay plus live tail.
- **terminal** = `Deferred.await` the `Turn`, or read `TurnComplete` off the stream.

The split that answers "does attach/detach belong in the interface?" (the guess
was: probably the recipe. That is right, with one clarification):

- **Core interface** carries the _provider-backed, durable-aware_ primitives:
  `submit -> ref`, `streamFrom(ref)`, `collect(ref)`, `status(ref)`, `cancel(ref)`.
  `streamFrom(ref)` **is** the attach primitive. For a server-backed job it
  re-attaches over the wire (OpenAI `starting_after`, Gemini `last_event_id`); for
  a virtual job it re-subscribes to the PubSub. Same signature, two backings.
  Detach is just "stop consuming the stream."
- **A recipe / runtime layer** owns the _ephemeral, in-process_ conveniences: the
  virtual-job registry (`Map<id, { pubsub, deferred, fiber }>`), a replay-buffer
  policy, a user-facing "detach / re-attach" toggle, and persistence of durable
  refs across restart. These sit on top of the interface. The durable, wire-level
  attach is already expressed by `streamFrom(ref)`; the toggle and the replay
  buffer are app policy, so they belong in the recipe exactly as guessed.

```ts
// recipe-level helper built on the interface (sketch)
const attachable = (request: ResearchRequest) =>
  Effect.gen(function* () {
    const ref = yield* DeepResearch.submit(request)
    const result = yield* Effect.forkDaemon(DeepResearch.collect(ref)) // runs on if you detach
    return {
      ref,
      events: DeepResearch.streamFrom(ref), // attach; call again to re-attach
      result: Fiber.join(result), // await the terminal Turn
      cancel: DeepResearch.cancel(ref),
    }
  })
```

## B.6 Revised service surface: a marker-free job core

The service a provider implements shrinks to the job primitives. `research` /
`researchStream` are **not** methods any provider writes; they are derived once in
core over the tag (Q1), so there is nothing to override:

```ts
// what a provider supplies — essentially JobOps<Turn> + streamFrom
export type DeepResearchService = {
  readonly submit: (request: ResearchRequest) => Effect<ResearchJobRef, AiError>
  readonly poll: (ref: ResearchJobRef) => Effect<ResearchState, AiError> // status + result
  readonly cancel: (ref: ResearchJobRef) => Effect<void, AiError>
  readonly streamFrom: (ref: ResearchJobRef) => Stream<TurnEvent, AiError> // real, or fromJob's synthesized default
}

// derived in core over the DeepResearch tag, requiring only DeepResearch in R:
//   status(ref)         = poll(ref)
//   collect(ref)        = repeat poll until settled              (Job.collect)
//   research(req)       = submit >>= collect  [onInterrupt cancel] (Job.run)
//   researchStream(req) = submit >>= streamFrom
```

Providers build their service with a single `fromJob` constructor that takes the
primitives and fills the synthesized `streamFrom` default when the provider is
poll-only:

```ts
DeepResearch.fromJob({ submit, poll, cancel }) // poll-only (Perplexity): streamFrom synthesized
DeepResearch.fromJob({ submit, poll, cancel, streamFrom }) // real SSE (OpenAI, Gemini)
```

**No markers on the generic capability.** `ResearchJob`, `ResearchStreaming`,
`DurableJob`, and the steering markers are all gone from the generic surface.
Everything non-uniform lives on the provider-typed tag or request instead:

| non-uniform thing                                            | where it lives              |
| ------------------------------------------------------------ | --------------------------- |
| `reasoningEffort`                                            | `PerplexityResearchRequest` |
| `maxSearches`, `reasoning`, `previousRef` (follow-up handle) | `OpenAIResearchRequest`     |
| collaborative `plan` / `refine`                              | `GoogleDeepResearch` tag    |
| durability (does a persisted ref survive a restart)          | documented per provider     |
| mid-run `steer`                                              | nowhere yet                 |

The generic tag is the portable job core; reach for a provider-typed tag exactly
when you want that provider's extra knob, the same pattern as every other
capability in the repo.

## B.7 What the recipe demonstrates

The canonical scenario is the **streaming background run**, because it is the case
the design optimizes for (B.1) and every other usage is a variation of it. The
recipe body is one consumption of `researchStream(request)`: forward the agent's
live progress to the terminal, then print the final cited report off the terminal
`Turn`.

```ts
export const nativeDeepResearch = (question: string) =>
  DeepResearch.researchStream({ history: [Items.userText(question)] }).pipe(
    Stream.tap((event) =>
      Match.value(event).pipe(
        Match.tag("WebSearchCall", (e) => Console.log(dim(`  ${e.status}: ${e.query ?? ""}`))),
        Match.tag("ReasoningDelta", (e) => writeDim(e.text)),
        Match.tag("TextDelta", (e) => write(e.text)),
        Match.tag("TurnComplete", (e) => printCitations(Turn.citations(e.turn))),
        Match.orElse(() => Effect.void),
      ),
    ),
  )
```

Portable over the generic tag: real events on OpenAI/Gemini, synthesized progress
on Perplexity, same body. The blocking `research()` (drop the stream, print the
final report) is offered only as the "I just want the report" footnote. Detach /
re-attach (persist the ref, `streamFrom(ref)` again later) is mentioned as a
follow-on, not the core body, since a CLI cannot cleanly demo walking away and
returning.

## B.8 Open questions

- **Virtual-job lifetime.** A daemon fiber holding a 30-minute connection needs a
  scope it dies with. Pin it to an app-controlled runtime `Scope`, not a global
  one. If the app exits, the virtual job dies. Acceptable, since sync providers
  cannot be collected from a fresh process anyway.
- **Did we give up too much compile-time honesty?** A.5 made a wrong
  `researchStream` a type error; B.4 makes it a documented low-fidelity stream.
  Confirm the "streaming everywhere is easy" goal is worth trading the gate for a
  `synthesized` label.
- **`previousRef` typing.** Follow-up rides as an optional provider-typed request
  field. Does the generic request need a neutral place to carry a prior `Turn`'s
  items, or is caller-side history threading enough? Leaning caller-threads.
- **Synthesized-progress fidelity.** Is a leading `WebSearchCall` + terminal
  `TurnComplete` enough for poll-only providers, or should the `fromJob` default
  emit heartbeat progress on each poll? Leaning minimal until a recipe needs more.
