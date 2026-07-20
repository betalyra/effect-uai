# Research: why OpenAI built the Responses API, and why everyone still uses Chat Completions

Subagent report, gathered 2026-07-15.

**Confidence tiers.** VERIFIED = quoted from the primary page as fetched, or from
raw HN Algolia data. FLAGGED = obtained only through page summarization, so wording
may be reworded; substance is right but the exact quote needs a direct read before
republishing.

## 1. Announcement and stated rationale

**VERIFIED.** Announced **2025-03-11**, alongside the Agents SDK and hosted tools
(web search, file search, computer use). Expanded **2025-05-21** with remote MCP,
image gen, code interpreter, background mode, and encrypted reasoning items.

The primary source is OpenAI's dev blog,
["Why we built the Responses API"](https://developers.openai.com/blog/responses-api)
(2025-09-22), not the March launch post:

- On Chat Completions' core defect: _"In Chat Completions, reasoning is dropped
  between calls, like the detective forgetting the clues every time they leave the
  room."_
- On Assistants: it _"never achieved mass adoption due to an API design that was
  limiting and hard to adopt."_
- The goal: _"something as approachable as Chat Completions, as powerful as
  Assistants, but also purpose built for multimodal and reasoning models."_
- On safety-driven design: _"preserving reasoning internally, encrypted and hidden
  from the client."_

Note: openai.com/index/\* returns 403 to fetchers; developers.openai.com works.

## 2. Chat Completions' future: supported at the endpoint, eroding at the capability

**VERIFIED.** The March 2025 commitment (via
[Simon Willison, 2025-03-11](https://simonwillison.net/2025/Mar/11/responses-vs-chat-completions/),
quoting OpenAI docs):

> "The Chat Completions API is an industry standard for building AI applications,
> and we intend to continue supporting this API indefinitely."

Reaffirmed Sept 2025: _"Chat Completions isn't going away. If it works for you,
keep using it."_ But with a succession claim: _"Just as Chat Completions replaced
Completions, we expect Responses to become the default way developers build."_
Current docs: _"While Chat Completions remains supported, Responses is recommended
for all new projects."_

**Assistants API. VERIFIED**
([deprecations page](https://developers.openai.com/api/docs/deprecations)):
notified **2025-08-26**, shutdown **2026-08-26**. A hard date, ~6 weeks out as of
this research.

**The caveat that matters more than the promise.** "Supported indefinitely" holds
at the endpoint level while eroding at the capability level. From the
[changelog](https://developers.openai.com/api/docs/changelog):

- **GPT-5.4 Pro** (2026-03-05) and **GPT-5.5 Pro** (2026-04-24) are
  **Responses-only**. Frontier models now ship without Chat Completions access.
- Starting **GPT-5.4**, tool calling is not supported in Chat Completions with
  `reasoning: none`.
- Computer use, tool search, skills, apply_patch: Responses-only.

OpenAI's own client is dropping it:
[openai/codex discussion #7782](https://github.com/openai/codex/discussions/7782)
removes `chat/completions` from Codex, **full removal Feb 2026**, because
_(FLAGGED, via summarization)_ the legacy protocol "has increasingly hampered our
ability to improve Codex."

So: the endpoint is safe, the frontier is not. Both are true simultaneously.

## 3. What is actually different

**Published numbers. VERIFIED**
([cookbook: reasoning items](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items)):

- **SWE-bench: ~3% improvement**, same prompt, same model, purely from including
  reasoning items. OpenAI's stated caveat: applies to tool-use/function-call
  scenarios where reasoning items from prior turns are passed forward.
- **Cache utilization: "boosted cache utilization from 40% to 80%."**

**Precision correction.** The
[migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
phrases this as _"40% to 80% improvement when compared to Chat Completions,"_ which
reads as "a 40-80% improvement." It isn't. The cookbook shows utilization moving
**from** 40% **to** 80%. The commonly-cited framing overstates it. Cost impact is
real but indirect (cached o4-mini input is 75% cheaper than uncached).

The Sept 2025 blog also cites **TAU-bench +5%** _(FLAGGED)_.

**Hosted tools. VERIFIED**
([comparison doc](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions)).
Responses-only: web search, file search, computer use, code interpreter, MCP, image
generation, reasoning summaries. Plus newer: tool search, skills, shell,
apply_patch.

Nuance: **web search is not strictly Responses-only.** Chat Completions has it via
`web_search_options`, but only on dedicated `gpt-4o-search-preview`-class models,
and it lacks domain filters, full source lists, live-access control, and token
budget control. A crippled variant, not parity.

**Inverted delta:** **audio is Chat Completions-only**; Responses lists it "Coming
soon." Chat Completions is not a strict subset.

**Reasoning persistence.** VERIFIED mechanism: `previous_response_id` _"renders
available, compatible reasoning items from earlier turns into the next sample."_
Stateless path: request `reasoning.encrypted_content` via `include`. OpenAI's
qualitative claim: _"allows the model to continue its reasoning process to produce
better results in the most token-efficient manner."_ The 3% / 40→80% numbers above
are the only published quantification found; the reasoning guide itself publishes
none.

**Background mode. VERIFIED**
([guide](https://developers.openai.com/api/docs/guides/background)). `background: true`,
poll GET while `queued`/`in_progress`. Streams **are** resumable: reconnect with
`starting_after` + last `sequence_number`. No Chat Completions equivalent.

**Item-based output and typed events.** VERIFIED: polymorphic output items
(message, reasoning, function*call, web_search_call, code_interpreter_call,
image_generation_call) vs `choices[].message`; typed SSE vs opaque deltas.
Multi-turn, OpenAI staff on HN: *"chat completions is a single turn api primitive
... responses is capable of making multiple model turns and tool calls in a single
api call"\_ ([44053763](https://news.ycombinator.com/item?id=44053763)).

## 4. Why third parties stay on Chat Completions

**Lingua franca. VERIFIED.** The single best comment,
[brittlewis12, HN 44053401](https://news.ycombinator.com/item?id=44053401):

> "since chat completions has become an informal industry standard, the responses
> api feels like an attempt by openai to break away from that shared interface,
> because it is so easy to swap out providers with nothing more than a base url and
> a model id, to a paradigm which requires data migration as well as replacement
> infrastructure (containers for code execution, for example)."

[simonw, Apr 2026](https://news.ycombinator.com/item?id=47851955), maintaining an
abstraction library:

> "The older OpenAI Chat Completions thing is much more of an ad-hoc standard -
> almost every provider ends up serving up a clone of that, albeit with frustrating
> differences because there's no formal spec to work against. The key problem is
> that providers are still inventing new stuff, so committing to a standard doesn't
> work for them."

**"Statelessness = portability" needs correcting.** Widely argued but weaker than it
looks: **`store=false` exists**, and OpenAI says so publicly in the same thread.
Statefulness is opt-out. The durable objection is not storage, it's the
**item-centric wire shape and hosted tools**. Worth not overstating.

**Server-side difficulty is the real reason, and it's underrated.** The centerpiece
is [vLLM RFC #24603](https://github.com/vllm-project/vllm/issues/24603): the
Responses API _"requires the responses store and message store to be enabled in
order to provide full functionality"_, which breaks horizontal scaling because
follow-ups must route to specific servers. **vLLM's proposed fix is to make
Responses stateless again.**
[llama.cpp #19138](https://github.com/ggml-org/llama.cpp/issues/19138) (opened Jan
2026, still open) has no `/v1/responses` at all. vLLM's
[#34857](https://github.com/vllm-project/vllm/issues/34857) is an _"H1 2026
lookahead"_, i.e. still roadmap.

**Tooling defaults. VERIFIED.**
[LangChain's ChatOpenAI](https://docs.langchain.com/oss/python/integrations/chat/openai)
defaults to Chat Completions and _"will route to the Responses API if one of these
features is used"_ (built-in tools, reasoning) or `use_responses_api=True`.
LiteLLM's default is Chat Completions with Responses opt-in via `openai/responses/`
prefix, plus a bidirectional bridge and a long defect tail
([#24664](https://github.com/BerriAI/litellm/issues/24664),
[#26267](https://github.com/BerriAI/litellm/issues/26267)). That bridge layer only
needs to exist because Chat Completions is the substrate.

**Honest signal read (INFERENCE, not citation):** the criticism is real but quiet.
Goedecke's [post](https://www.seangoedecke.com/responses-api/) never cleared 3
points across six HN submissions. Chat Completions' persistence looks less like
revolt and more like simonw's account: no formal spec, providers still churning, so
the ad-hoc clone wins by default while OSS servers work through a genuinely harder
implementation.

## 5. Industry trend: Open Responses changes the picture

**The biggest update in this report.** "OpenRouter beta + Requesty" understates
adoption by a lot.

**[Open Responses](https://www.openresponses.org/)** launched **~2026-01-14/15**,
led by OpenAI DevRel: _"an open-source specification and ecosystem for building
multi-provider, interoperable LLM interfaces based on the OpenAI Responses API,"_
community-maintained under a technical charter.

Logos on the site: **NVIDIA, Vercel, OpenRouter, Hugging Face, LM Studio,
Databricks, Red Hat, AWS, Ollama, OpenAI, vLLM, Llama Stack**
([InfoQ, Feb 2026](https://www.infoq.com/news/2026/02/openai-open-responses/)).

vLLM's [public reaction](https://x.com/vllm_project/status/2012015593650536904):

> "When we added support for gpt-oss, the Responses API didn't have a standard and
> we essentially reverse-engineered the protocol by iterating and guessing based on
> the behavior. We are very excited about the Open Responses spec."

**Notably absent: Anthropic and Google DeepMind.**

**Azure. VERIFIED:** Responses API supported; Conversations API arrived via the
Foundry v1 REST API around April 2026, though
[Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5916654/azure-openai-conversations-api-endpoint-returns-40)
shows people still hitting 404s. Lagging, not absent.

**The detail to weight heaviest:**
[OpenRouter's Responses API](https://openrouter.ai/docs/api/reference/responses/overview)
is **beta and explicitly stateless**: _"each request is independent and no
conversation state is persisted between requests."_ Combined with vLLM RFC #24603
proposing to strip state, a pattern emerges: **the ecosystem is adopting the
Responses wire format while rejecting its server-side state.** The item shape is
winning; the statefulness is not.

## 6. Honest read as of mid-2026

Chat Completions is **neither legacy nor safely permanent**. It is a stable lingua
franca being hollowed out from the top.

For "stable lingua franca": an explicit indefinite-support pledge, universal
provider support, framework defaults, audio still exclusive to it, and OSS servers
years from Responses parity.

For "legacy": Assistants dies 2026-08-26; GPT-5.4 Pro and 5.5 Pro never shipped to
it; OpenAI removed it from its own Codex client; every tool since March 2025 is
Responses-only; and Open Responses gave the format the formal spec and neutral
governance whose absence was simonw's stated blocker.

**Read: the wire format war is over and Responses won, but the statefulness war is
being lost.** Open Responses backed by NVIDIA/AWS/Red Hat/Databricks/vLLM/Ollama is
a different thing from a proprietary OpenAI endpoint, and it defuses the strongest
lock-in objection. But adopters are consistently implementing it stateless. The
likely 2027 equilibrium is the Responses _item model_ as the standard, with
server-side state treated as an OpenAI-specific optimization rather than part of
the contract.

**For effect-uai:** the `responses` package naming (per the one-API-surface-per-package
convention) ages well under this reading, and the **Open Responses spec is worth
tracking as the thing to conform to**, rather than OpenAI's endpoint per se.

## Caveats

The Codex #7782 maintainer quote and the TAU-bench +5% figure came via page
summarization; read both directly before republishing. HN comments from the March
2025 launch thread (43334644) that circulate in summaries could not be confirmed
against raw Algolia data and are omitted deliberately.
