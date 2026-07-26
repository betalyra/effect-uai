# Managed agents: research + design note

Status: research and design exploration. Not implemented in `packages/`.
Captured 2026-07 from provider docs. Companion to [deep-research.md](./deep-research.md)
(the shipped `DeepResearch` capability this is contrasted against).

Provider facts below are dated and mostly **preview/beta**; every load-bearing
claim carries its source. Treat exact wire field names as verify-before-code.

---

## Position (the short version)

A "managed agent" is a **provider-hosted agent loop**: you create a run or
session, the provider runs the search/read/reason/act loop server-side, and you
poll or stream it. This is a genuinely different capability from both
`DeepResearch` (one-shot, terminal, a single cited `Turn`) and from the
library's own `Loop` (local, you run the loop). It is worth modeling.

But the backing is thin and unstable. Only **two** providers offer the clean
shape today (Anthropic Managed Agents, Gemini Interactions managed agents), both
in preview, with materially different object models. OpenAI is actively
retreating from hosting the loop (Assistants sunset, Agent Builder sunset,
steering users to a self-hosted SDK). So:

- **Do not ship a generic `ManagedAgent` tag yet.** Implement provider-typed
  services first (`Anthropic.ManagedAgent`, `Gemini.ManagedAgent`); let the
  common surface reveal itself from two real adapters.
- **Position it as an escape hatch**, not a default. It sits in tension with the
  library's thesis (composable local loops); it is the "hand the loop to the
  provider" option, mirroring how Anthropic itself frames Messages API vs
  Managed Agents.
- **Do not fold Exa or `DeepResearch` into it.** `DeepResearch` stays the simple,
  portable, three-provider capability. (Exa deep research was removed: its
  Research API is retired and its replacement is the general Agent API, which is
  a managed-agent primitive, not a deep-research one.)

---

## 1. What "managed agent" means, and what it isn't

Three provider-hosting shapes get called "agents". Conflating them is the main
trap.

- **A1: the provider runs its own loop.** You create a run/session against the
  provider's model + hosted tools; it searches, reads, reasons, and acts
  server-side; you poll or stream. You own the _task_, not the _loop_.
  Examples: Anthropic Managed Agents, Gemini Interactions managed agents, Exa
  `/agent/runs`, OpenAI Assistants (deprecated). **This is what `ManagedAgent`
  should mean.**
- **A2: the provider hosts _your_ agent code.** Any framework, packaged and run
  on their infra with managed sessions/scaling. The loop logic is yours; the
  hosting is theirs. Examples: AWS Bedrock AgentCore, Google Vertex AI Agent
  Engine. **Out of scope**: this is a deploy target, not a capability an SDK
  wraps.
- **A-lite: a tool loop _within a single turn_.** The provider runs hosted tools
  inside one response and optionally persists conversation state, but there is
  no long-lived run/session object you create and poll. Examples: OpenAI
  Responses + Conversations, Mistral agents + conversations, xAI Grok Agent
  Tools. Broader backing, weaker "agent" semantics.

Two boundaries matter for us:

**vs `DeepResearch`.** `DeepResearch` is the degenerate case of A1: a fixed
"research" configuration, run once, collapsed to a terminal `Turn` (report +
citations + optional structured output). It has no multi-turn state, no
mid-run steering, no observable tool calls, no filesystem. You cannot express
those through it without distorting it. That inexpressibility is the proof
`ManagedAgent` is a separate capability, not an extension of `DeepResearch`.

**vs `Loop`.** effect-uai's core primitive is the _local_ agent loop: you hold
state, stream a turn, run tools, decide continuation. A managed agent is the
inverse: the provider holds the loop and the state. That is a real philosophical
tension (see §3), and it is why this should read as a deliberate escape hatch.

---

## 2. Provider survey

| Provider  | Product                                   | Class              | Create + read                                                                            | Status                              | Source                                     |
| --------- | ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| Anthropic | Managed Agents                            | **A1**             | `POST /v1/sessions` + events; `GET …/stream` (SSE)                                       | beta (`managed-agents-2026-04-01`)  | platform.claude.com/docs/en/managed-agents |
| Google    | Interactions managed agents (Antigravity) | **A1**             | `POST /v1beta/interactions` (`agent`, `background`); `GET …/{id}` poll or `?stream=true` | Interactions GA; agents **preview** | ai.google.dev/gemini-api/docs/agents       |
| OpenAI    | Assistants (threads/runs)                 | A1                 | `/v1/threads/{id}/runs`                                                                  | **deprecated, sunset 2026-08-26**   | community deprecation notice               |
| OpenAI    | Responses + Conversations                 | A-lite             | `POST /v1/responses` (`background`) + `POST /v1/conversations`                           | GA                                  | developers.openai.com                      |
| OpenAI    | AgentKit / Agent Builder                  | A1-ish             | hosted workflow runtime                                                                  | **sunset 2026-11-30**               | openai.com/index/introducing-agentkit      |
| Mistral   | Agents + Conversations                    | A-lite → A1        | `POST /v1/agents` + `POST /v1/conversations`                                             | GA                                  | docs.mistral.ai/studio-api/agents          |
| xAI       | Grok Agent Tools                          | A-lite             | server tool loop inside a chat call                                                      | GA-ish                              | x.ai/news                                  |
| Cohere    | Chat tool-use                             | none (client loop) | n/a                                                                                      | GA                                  | docs.cohere.com                            |
| AWS       | Bedrock AgentCore                         | **A2**             | `InvokeAgentRuntime` (your code)                                                         | preview                             | docs.aws.amazon.com/bedrock-agentcore      |
| Google    | Vertex AI Agent Engine                    | **A2**             | `adk deploy` + Sessions API (your code)                                                  | GA-ish                              | cloud.google.com/agent-builder             |

### Anthropic Managed Agents (A1, the reference shape)

Four objects: **Agent** (model + system + tools + MCP + skills; versioned,
reusable), **Environment** (where sessions run: Anthropic `cloud` sandbox or
`self_hosted`), **Session** (a running instance holding history + sandbox
state), **Events** (messages both ways).

- Endpoints (all need `anthropic-beta: managed-agents-2026-04-01`):
  `POST /v1/agents`, `POST /v1/environments`, `POST /v1/sessions`,
  `POST /v1/sessions/{id}/events` (send a `user.message` or `user.interrupt`),
  `GET /v1/sessions/{id}/stream` (SSE), `GET /v1/sessions/{id}/events` (history),
  `DELETE /v1/sessions/{id}`.
- Long-lived, multi-turn, **steerable mid-run** (send more events, or
  `user.interrupt`). Server-side state keyed by `session_id`, so you can
  reconnect the stream or refetch history from any process. Recommended pattern:
  open the stream, then post the event (the API buffers until the stream
  attaches).
- SSE event taxonomy is authoritative (assistant text on `agent.message`
  content blocks; `agent.tool_use` / `agent.tool_result`; terminal
  `session.status_idle` with a `stop_reason`, where `requires_action` blocks on
  a tool confirmation or custom-tool result). Exact per-event JSON is
  verify-before-code.
- Built-in toolset `agent_toolset_20260401`: `bash`, `read`/`write`/`edit`/
  `glob`/`grep`, `web_fetch`, `web_search`; remote MCP; custom tools
  (`agent.custom_tool_use` answered by `user.custom_tool_result`); skills.
  Managed cloud sandbox or self-hosted (tool execution on your worker via a
  poll/claim work queue; tool I/O still transits Anthropic's control plane).
- **No documented structured/JSON-schema final output.** `input_schema` on the
  tools page is for tool inputs, not model output.
- Not eligible for Zero Data Retention or HIPAA BAA (stateful by design). Create
  endpoints 300 req/min, read/stream 1,200 req/min. Positioned explicitly
  against the Messages API: "Instead of building your own agent loop, tool
  execution, and runtime, you get a fully managed environment." **"Research" is
  not a listed use case**; the exemplar is coding/file/bash work.

Distinct from the **Claude Agent SDK**, which is a _client library_ that runs the
loop in your own process (files on your infra, local JSONL sessions). Anthropic's
own framing: SDK = library you run; Managed Agents = hosted runtime they run.

### Gemini Interactions managed agents (A1)

The **Interactions API** (`POST /v1beta/interactions`, GA 2026-06-22) is Google's
unified primitive for "models _and_ agents": pass a `model` id for inference or
an `agent` id for an autonomous task, same endpoint. Managed agents:
`antigravity-preview-05-2026` (general-purpose, Gemini-3.6-Flash, sandboxed
code/files/web), plus `deep-research-preview-04-2026` and its Max variant. Deep
research is **just one agent on this primitive**, which is exactly why our
`GoogleDeepResearch` already rides Interactions and exposes only the research
slice.

- Multi-turn via `previous_interaction_id` (server-side history); managed agents
  add an `environment`/`environment_id` sandbox dimension. Note: `tools`,
  `system_instruction`, `generation_config` do **not** persist across turns and
  must be re-sent each call.
- Execution states: `in_progress`, `requires_action`, `completed`, `failed`,
  `cancelled`, `incomplete`, `budget_exceeded`, `queued`. `requires_action` is
  the client-side tool/HITL pause (carries a `function_call` step); resume by
  posting a `function_result` input referencing the paused interaction.
- `background=true` (mandatory for deep research, requires `store=true`) for
  long tasks; `?stream=true&last_event_id=…` for resumable SSE. Structured
  output via `response_format` (JSON schema). Output on `output_text`; citations
  on `annotations[]`; observable steps on `steps[]`.
- Everything agent-side is **preview** (dated agent ids, churny `agent_config`);
  the GA guarantee covers the Interactions envelope, not the agents.

### The A-lite middle (OpenAI, Mistral, xAI)

- **OpenAI** gives three _separable_ primitives, not one agent-run object:
  async execution (`POST /v1/responses` `background:true` → poll
  `GET /v1/responses/{id}`, ~10-min TTL, an execution buffer not a store),
  server-side hosted tools within a response (`web_search`, `code_interpreter`,
  `file_search`, `computer_use`), and server-side state (`previous_response_id`
  or the Conversations API). There is **no live create-and-poll agent run**.
  The only true A1 (Assistants) sunsets 2026-08-26; the hosted Agent Builder
  sunsets 2026-11-30; OpenAI steers to the **self-hosted Agents SDK**. Signal:
  OpenAI is moving _away from_ hosting the loop.
- **Mistral** is the cleanest non-preview stateful shape: `POST /v1/agents`
  (persistent agent) + `POST /v1/conversations` (agent_id + inputs, server-side
  context via `conversation_id`), with hosted web-search/code/RAG tools + MCP.
  Whether it self-loops many turns unattended vs per-request is unverified.
- **xAI Grok** runs a server-side tool loop "until the final answer" but inside a
  single chat call, no separate run resource. **Cohere** has no hosted agent
  runtime (client-driven tool use).

### A2 (out of scope)

**AWS Bedrock AgentCore** and **Vertex AI Agent Engine** host _your_ agent code
(any framework) with managed sessions/scaling. They are deploy targets, not a
model-provider capability an SDK wraps. Note them so the taxonomy is complete;
do not target them.

---

## 3. The tension with the library's thesis

effect-uai exists to make _local, composable_ agent loops: `Loop` + streamed
turns + tools + explicit continuation, all in your process, all inspectable. A
managed-agent capability inverts that: the provider owns the loop, the state,
the sandbox, and the tool execution. You get convenience (long-running,
sandboxed, zero infra) and give up control and portability (each provider's
session model is bespoke; there is no local equivalent to inspect or test
against).

This is not a reason to reject it. It is a reason to **scope and frame it as an
escape hatch**, exactly as Anthropic frames its own two tiers (Messages API =
build your own loop; Managed Agents = they run it). The capability should read
as "when you want the provider to run a long, sandboxed, tool-heavy job and you
do not want to own that loop", sitting beside `Loop`, never replacing it.

---

## 4. How it would map onto the codebase

`DeepResearch` builds its whole service from `Job` (submit / poll / cancel) via
`fromJob`, because a research job is terminal: one submit, poll to a single
`Turn`. A managed agent needs more than `Job` can express:

- **Multi-turn**: send follow-up events to a live session, not just submit once.
- **Observable steps**: stream real tool calls / results / thinking, not a
  synthesized progress bar.
- **Steering / interrupt**: post an event mid-run to redirect or stop.
- **Session identity**: a serializable handle you reconnect to from another
  process (both providers key state by a server-side id, like our
  `ResearchJobRef` but longer-lived and mutable).
- **Sandbox lifecycle** (Anthropic Environment, Gemini `environment_id`): a
  dimension neither `Loop` nor `DeepResearch` has.

A plausible provider-typed shape (sketch, not a commitment):

```
ManagedAgentService = {
  create:   (config)            => Effect<SessionRef, AiError>
  send:     (ref, event)        => Effect<void, AiError>          // user turn / tool result / interrupt
  stream:   (ref)               => Stream<AgentEvent, AiError>    // observable steps, real SSE
  history:  (ref)               => Effect<ReadonlyArray<AgentEvent>, AiError>
  cancel:   (ref)               => Effect<void, AiError>
  delete:   (ref)               => Effect<void, AiError>
}
```

`SessionRef` is serializable data (like `ResearchJobRef`), so a session survives
process boundaries. The async/poll pieces can reuse the `Job` machinery; the
streamed-steps piece reuses the SSE plumbing the providers already have
(`GoogleDeepResearch` streams Interactions; the Anthropic provider streams
Messages). `AgentEvent` is the hard modeling problem: it must generalize
Anthropic's `agent.*` events and Gemini's `steps[]` without flattening away tool
calls, results, and terminal `requires_action`.

Open modeling questions this sketch defers: whether to model the sandbox/
environment at all or treat it as provider-typed config; how to represent
mid-run tool confirmation (`requires_action`) uniformly; whether structured
final output belongs on the capability (Gemini yes via `response_format`,
Anthropic no).

---

## 5. Options

- **A. Provider-typed only, no generic tag (recommended).** Ship
  `Anthropic.ManagedAgent` and `Gemini.ManagedAgent` as provider-typed services.
  Let the generic `ManagedAgent` tag crystallize only after two real adapters
  expose the true common surface. Same "views over shared transport" position we
  already hold: `GoogleDeepResearch` rides Interactions and shows the research
  slice; a `Gemini.ManagedAgent` would ride the same transport and show more.
- **B. Generic `ManagedAgent` tag now.** Premature. Two preview APIs with
  different object models (Agent/Environment/Session/Events vs Interactions +
  `previous_interaction_id` + environment) will thrash the abstraction. The
  earlier `providerData` and capability work shows the cost of unifying shapes
  that are not yet uniform.
- **C. Target the A-lite shape instead** (stateful conversation + server-side
  hosted tools). Broader backing (OpenAI Conversations+Responses, Mistral,
  Gemini, xAI), but it is a weaker "agent": no self-driving multi-turn loop, and
  it overlaps heavily with what `Loop` + hosted tools already do locally. Worth
  a separate look, but it answers a different question than "let the provider run
  the whole loop".
- **D. Don't build; document as a non-goal.** Defensible given the thin, churny
  backing and the philosophical tension. The risk is missing the shape as
  Anthropic/Gemini move it to GA.

---

## 6. Recommendation

Option **A**, staged, and not urgent.

1. Keep `DeepResearch` as the simple portable capability (OpenAI, Perplexity,
   Gemini). Do not extend it toward sessions.
2. When there is a concrete consumer need, implement `Anthropic.ManagedAgent`
   and `Gemini.ManagedAgent` **provider-typed**, framed as an escape hatch
   beside `Loop`. Reuse `Job` for async/poll and the existing SSE plumbing for
   streamed steps.
3. Extract a generic `ManagedAgent` tag only once both adapters exist and the
   `AgentEvent` union has proven itself against both, ideally after the
   providers leave preview.
4. Revisit Option C (the A-lite conversation shape) separately; it may be the
   more broadly-supported thing, but it is a different capability and partly
   redundant with local `Loop`.

Rationale: the capability is real and distinct, but a cross-provider tag over two
preview APIs is exactly the "unify what isn't yet uniform" mistake the codebase
has paid for before. Provider-typed first is cheap, honest, and reversible.

---

## 7. Open questions

- **Naming.** `ManagedAgent` vs `HostedAgent` vs `RemoteAgent`. The distinguishing
  trait is _who runs the loop_ (the provider), so a name that says "hosted/remote
  loop" beats "provider agent" (a `Loop` + provider already is that).
- **Sandbox/environment.** Model it as a first-class object, provider-typed
  config, or ignore it in the generic surface? Anthropic makes it prominent;
  Gemini folds it into `environment_id`.
- **`requires_action` / tool confirmation.** Both providers pause mid-run for a
  tool result or HITL approval. Can this reuse the tool-approval recipe shape, or
  does server-hosting change the contract?
- **Structured final output.** Gemini supports `response_format`; Anthropic does
  not document one. Keep it provider-typed rather than promising a uniform knob.
- **Self-hosted sandbox** (Anthropic). Interesting for data residency, but tool
  I/O still transits the control plane. Probably out of an initial scope.
- **Stability.** Everything A1 here is preview/beta with dated ids. Recheck
  before committing; the landscape moved twice in 2026 already (Exa retired
  research; OpenAI is sunsetting Assistants and Agent Builder).

---

## Sources

Anthropic Managed Agents: `https://platform.claude.com/docs/en/managed-agents/`
(overview, quickstart, sessions, reference, self-hosted-sandboxes,
session-operations, tools, agent-setup). Claude Agent SDK:
`https://code.claude.com/docs/en/agent-sdk/overview`.

Gemini: `https://ai.google.dev/gemini-api/docs/` (interactions-overview, agents,
background-execution, managed-agents-quickstart, deep-research),
`https://ai.google.dev/api/interactions-api`, GA post
`https://blog.google/innovation-and-ai/technology/developers-tools/interactions-api-general-availability/`.

OpenAI: `https://developers.openai.com/api/docs/guides/` (background,
conversation-state, agents), AgentKit `https://openai.com/index/introducing-agentkit/`,
Assistants deprecation (OpenAI community). Mistral:
`https://docs.mistral.ai/studio-api/agents/introduction`. xAI: `https://x.ai/news`.
Cohere: `https://docs.cohere.com/docs/tool-use-quickstart`. AWS Bedrock AgentCore:
`https://docs.aws.amazon.com/bedrock-agentcore/`. Vertex AI Agent Engine:
`https://cloud.google.com/agent-builder/agent-engine/overview`.
