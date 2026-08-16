# Research: tool call ids across providers

Subagent report + local code verification, gathered 2026-07-15.
VERIFIED = confirmed against vendor docs or read directly in our source.

## The question

Do providers guarantee a tool call id on the wire, and is our domain's required
`call_id: Schema.String` modelling something the wire doesn't provide?

## Gemini: `functionCall.id` is optional, and the model generation decides

**Schema. VERIFIED** ([FunctionCall reference](https://ai.google.dev/api/caching#FunctionCall),
v1beta REST; Vertex `v1beta1` carries identical wording):

- `functionCall.id` — **Optional**: _"Unique identifier of the function call. If
  populated, the client to execute the `functionCall` and return the response with
  the matching `id`."_ The conditional _"If populated"_ is the contract explicitly
  anticipating absence.
- `functionResponse.id` — **Optional**: _"The identifier of the function call this
  response is for. Populated by the client to match the corresponding function call
  `id`."_ Note "populated by the **client**".

**Pre-Gemini-3 `generateContent` returns no id. VERIFIED:**

- [Phil Schmid's guide](https://www.philschmid.de/gemini-function-calling) with
  `gemini-2.0-flash` prints `id=None args={...} name='get_weather_forecast'`.
- [gemini-cli #6974](https://github.com/google-gemini/gemini-cli/issues/6974):
  reporter observed a `FunctionCall` with no `id` while the paired
  `FunctionResponse` had a client-generated one. Closed as stale, no maintainer
  resolution.

**Gemini 3 always returns it, and requires it echoed back. VERIFIED**
([function-calling guide](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)):

> "Gemini 3 now always returns a unique `id` with every `functionCall`. Include
> this exact `id` in your `functionResponse` so the model can accurately map your
> result back to the original request."

> "When the model initiates multiple function calls in a single turn, you don't
> need to return the `function_result` objects in the same order that the
> `function_call` objects were received. The Gemini API maps each result back to
> its corresponding call using the `id` from the model's output."

**Live API always uses ids. VERIFIED** ([Live API](https://ai.google.dev/api/live)):
_"Individual `FunctionResponse` objects are matched to the respective
`FunctionCall` objects by the `id` field."_

**`thoughtSignature` is orthogonal. VERIFIED**
([thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)):
for parallel calls the signature attaches **only to the first** `functionCall`
part; for sequential calls every call has one and all must be replayed. Missing
signature is a hard 400. Signature presence is per-part-position, id presence is
per-model-generation; they do not co-vary. The signature docs' own JSON examples
show `functionCall` with `name`/`args`/`thoughtSignature` and **no** `id`.

**Could NOT determine:** whether stable `v1` lists `id` on FunctionCall at all
(reference pages 404 after reorganization); whether `id` appears on every streamed
`partialArgs` chunk under Gemini 3's opt-in
`streamFunctionCallArguments` (inferred present on at least the first chunk).

## OpenAI Chat Completions. VERIFIED against the OpenAPI spec

Grepped from [openai-openapi/master/openapi.yaml](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml)
(83k lines), i.e. schema definitions rather than doc prose.

**Non-streaming: `id` is REQUIRED.** `ChatCompletionMessageToolCall` (line 30337)
has `required: [id, type, function]`. Same for
`ChatCompletionMessageCustomToolCall`. Every element of
`choices[].message.tool_calls[]` is spec-guaranteed to carry a non-null `id`.

**Streaming: only `index` is required.** `ChatCompletionMessageToolCallChunk`
(line 30373) has `required: [index]` alone. `id`, `type`, and `function` are all
optional, and the nested `function` object has **no `required:` list at all**, so
`name` and `arguments` are individually optional too.

> This vindicates a defensive fallback: per spec, a streaming chunk may legally
> arrive with no `id`. Our `tc.id ?? …` is correct posture, not paranoia.

**"First delta carries the id" is NOT normative. INFERRED.** No sentence in the
spec or current guide states that `id`/`name` arrive on the first delta per index
with later deltas carrying only arguments. The nearest official example of the
shape is the Assistants run-step delta stream (spec lines 19327-19341). Universally
observed, matches schema optionality, but **not a written guarantee**: key
accumulation on `index`, treat `id`/`name` as first-seen-wins.

**No id format constraint. VERIFIED ABSENT.** No `pattern`, `maxLength`,
`minLength`, or prose about a `call_` prefix anywhere. The prefix appears only in
examples. **Do not validate against it.**

**`index` is not guaranteed dense or zero-based.** The spec gives `index` no
description at all, and there is a third-party report of a gateway emitting 1-based
indices. Do not assume `index == array position`.

## OpenAI Responses. VERIFIED, and the subtle one

`FunctionToolCall` (line 39902) has `required: [type, call_id, name, arguments]`.
**`id` is NOT in that list.** A separate `FunctionToolCallResource` (line 40034) is
`allOf[FunctionToolCall, {required: [id, status]}]`.

Which applies where matters: `Response.output[]` and the
`response.output_item.added`/`.done` events all reference `OutputItem` (line
44468), which uses **`FunctionToolCall`**, the variant where `id` is optional. Only
the items-listing endpoints use the `Resource` variant.

> So `call_id` is guaranteed on every `function_call` item; `id` is not. For a
> spec-backed correlation key in Responses, use **`call_id`**. Our
> `call_id: Schema.String` (required) in
> [responses/src/codec.ts:73](../../packages/providers/responses/src/codec.ts#L73)
> is correct.

Semantics: `id` = the **item** id (`fc_…`); `call_id` = the **function call** id
(`call_…`), and `call_id` is what you echo in `function_call_output`
(`FunctionToolCallOutput`, line 39956, `required: [type, call_id, output]`). The
Realtime spec states the contract most clearly (line 50152): _"If passed on a
`function_call_output` item, the server will check that a `function_call` item with
the same ID exists in the conversation history."_

**The streaming asymmetry trap.** `response.output_item.added` carries both `id`
and `call_id` complete in one shot. But subsequent
`response.function_call_arguments.delta` events carry **`item_id`** (the `fc_…`
item id), _not_ `call_id`. So arg deltas correlate by item id, and you must have
stashed `call_id` from `output_item.added` to build the eventual output. Unlike
Chat Completions, where the delta carries the same id you echo back.

> We already handle this:
> [streamEvents.ts:200](../../packages/providers/responses/src/streamEvents.ts#L200)
> resolves `call_id` from `item_id` via a lookup rather than using `item_id`
> directly.

## Anthropic. VERIFIED: id always present

The Messages API reference (docs.claude.com now 301s to platform.claude.com) lists
`ToolUseBlock { id, caller, input, … }` with `id: string` and no optional
qualifier. The tool-use guide states: _"`id`: A unique identifier for this
particular tool use block. This will be used to match up the tool results later."_

**Streaming: the full `id` arrives complete in `content_block_start`**, and every
subsequent delta carries only `partial_json`. By design: _"The deltas for
`tool_use` content blocks correspond to updates for the `input` field of the
block."_ Nothing else in the block is ever delta'd. Same for `server_tool_use`
(`srvtoolu_…`) and MCP (`mcptoolu_…`).

**No format guarantee.** The schema says only `id: string`. No documented prefix,
length, or charset. Observed ids run 24-25 chars after the prefix, undocumented.
Treat prefixes as convention, not contract.

`tool_result.tool_use_id` must match, and the structural rules are strict: tool
results must immediately follow the tool*use message and come first in the content
array, else a 400 with *"tool*use ids were found without tool_result blocks
immediately after"*.

> Implication: our `Option.getOrElse(block.id, () => "")` fallback
> ([anthropic/src/codec.ts:586](../../packages/providers/anthropic/src/codec.ts#L586))
> should never fire in practice. Lower priority than initially assessed, though
> `""` is still a poor sentinel if it ever did.

## Mistral. VERIFIED from the OpenAPI spec

From [docs.mistral.ai/openapi.yaml](https://docs.mistral.ai/openapi.yaml), the
`ToolCall` schema:

```yaml
ToolCall:
  properties:
    id: { type: string, default: "null" }
    type: { $ref: ToolTypes, default: function }
    function: { $ref: FunctionCall }
    index: { type: integer, default: 0 }
  required: [function]
```

- **`id` is NOT required.** Only `function` is. The `default: 'null'` is the
  literal 4-char string, a known Mistral spec-generation artifact.
- **One shared schema in both directions**, referenced from
  `AssistantMessage.tool_calls` (request) and from the response choice. So the spec
  gives no schema-level guarantee that a response id is present. Mistral does emit
  ids in practice, but that is INFERRED from user reports.
- **The `^[a-zA-Z0-9]{9}$` pattern is NOT in the public spec.** The only patterns
  in the 33k-line file are `^[a-zA-Z0-9_-]{1,64}$` on unrelated name fields.

**The 9-char rule is a request-side 400, VERIFIED with real error text:**

> `Tool call id was exec1774786568428215 but must be a-z, A-Z, 0-9, with a length of 9.`

Reported in [openclaw#23595](https://github.com/openclaw/openclaw/issues/23595),
[vercel/ai#11802](https://github.com/vercel/ai/issues/11802),
[vllm#9019](https://github.com/vllm-project/vllm/issues/9019). Could **not** verify
from any official source that Mistral's own generator is contractually guaranteed
to emit 9-char ids.

## OpenRouter. VERIFIED: does NOT normalize ids

It standardizes the _shape_ (OpenAI `tool_calls[]` envelope) but passes the
upstream provider's id value through **verbatim**. Evidence: Claude via OpenRouter
returns `toolu_…`, not `call_…`
([gptel#747](https://github.com/karthink/gptel/issues/747)); and Mistral via
OpenRouter rejects ids originating from other providers
([openclaw#52548](https://github.com/openclaw/openclaw/issues/52548), #47707,
#57672). Clients ship their own normalization to compensate
([Roo-Code#10102](https://github.com/RooCodeInc/Roo-Code/pull/10102),
"normalize tool call IDs for cross-provider compatibility via OpenRouter").

> Implication for our OpenRouter package: it inherits the whole cross-provider id
> problem. Switching models mid-conversation _within_ OpenRouter reproduces exactly
> the Mistral failure, without ever leaving one "provider" from our layer's point
> of view. Gemini is the known risk: its native `functionCall` has no id, so any id
> seen through OpenRouter was synthesized somewhere in the chain. Treat presence as
> best-effort, not guaranteed.

## Jina DeepSearch. No tool calling

No `tools`, `tool_choice`, or `tool_calls` in the docs or the
[open-source implementation](https://github.com/jina-ai/node-DeepResearch); its
search/read/reason tools are internal to the agent loop. Caveat:
`deepsearch.jina.ai/openapi.json` returns 401, so the authoritative schema could
not be read. INFERRED from absence across three sources rather than an explicit
"not supported" statement.

## What our code actually does. VERIFIED locally

| Provider  | Wire source                      | Fallback when absent                                                                                              | Sent back to wire?    |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------- |
| Responses | `f.call_id`                      | none (schema requires)                                                                                            | yes, verbatim         |
| Anthropic | `content_block.id`               | `""` ([codec.ts:586](../../packages/providers/anthropic/src/codec.ts#L586))                                       | yes, verbatim         |
| Google    | `functionCall.id`, Gemini 3 only | `` `${name}_${priorCalls.length}` `` ([codec.ts:621-628](../../packages/providers/google/src/codec.ts#L621-L628)) | **no, see bug below** |
| Mistral   | `tc.id`                          | `` `call_${index}` `` ([codec.ts:261](../../packages/providers/mistral/src/codec.ts#L261))                        | yes, verbatim         |

Two distinct roles emerge, and they have different requirements:

- **Google**: `call_id` is an internal handle. The outbound `functionResponse`
  correlates by **name**, resolved via `nameForCallId(history, o.call_id)`
  ([codec.ts:377-380](../../packages/providers/google/src/codec.ts#L377-L380)).
  The synthesized `name_0` never reaches the wire, so its format is irrelevant.
- **Everyone else**: `call_id` is passed to the wire verbatim, so whatever we
  synthesize must satisfy that provider's constraints.

## Bug: we never send `functionResponse.id`, even on Gemini 3

The `RequestPart` type
([codec.ts:137-141](../../packages/providers/google/src/codec.ts#L137-L141)) has no
`id` field, and the construction site
([codec.ts:377-380](../../packages/providers/google/src/codec.ts#L377-L380)) emits
only `{ name, response }`. But the doc comment at
[codec.ts:29-34](../../packages/providers/google/src/codec.ts#L29-L34) claims the
Gemini 3 id _"we echo back on the corresponding `functionResponse`"_. It does not.

We do echo the id on the outbound **functionCall**
([codec.ts:362-368](../../packages/providers/google/src/codec.ts#L362-L368)) via
`providerIdFor`, so the id survives the round trip in one direction only.

**Impact:** per the Gemini 3 docs above, results are mapped back to calls by `id`.
Without it Gemini falls back to name/order matching, so **parallel calls to the
same function name in one turn can be mis-paired** — the tool result for call A
attributed to call B. Silent wrong answers, not an error.

**Fix:** add `id` to the `functionResponse` request part and populate it from the
originating call's `providerData.gemini.id` when present, omitting it otherwise
(pre-Gemini-3 has no id to echo and the field is optional). Keep entirely separate
from `thoughtSignature`, which has its own first-part-only-for-parallel rule.

## Established SDK practice for Gemini. VERIFIED from source

Every major SDK **synthesizes a client-side id**. They diverge only on whether it
goes on the wire:

| SDK                     | Ingest                                        | Sends `id` on wire?          |
| ----------------------- | --------------------------------------------- | ---------------------------- |
| Vercel AI SDK           | `part.functionCall.id ?? config.generateId()` | always, ungated              |
| LangChain Python        | `raw_id or uuid.uuid4()`                      | never — name + position      |
| LangChain JS            | always uuid4, server id **discarded**         | never — name + position      |
| LiteLLM                 | server id or `call_<uuid>`                    | only for AI Studio Gemini 3+ |
| google-genai (official) | ignores id entirely                           | never — name + position      |

LiteLLM is the only one that encodes a gate, and its comment is the sharpest claim
found anywhere:

> _"Gemini 3+ on Google AI Studio accepts (and returns) `id` for strict tool-call
> matching. **Vertex AI rejects the field with HTTP 400.**"_

Corroborated independently with the actual error text,
`Unknown name "id" at contents[].parts[].function_call`, in
[mlflow#24127](https://github.com/mlflow/mlflow/issues/24127),
[OmniRoute#3374](https://github.com/diegosouzapw/OmniRoute/issues/3374), and
[LibreChat#13259](https://github.com/danny-avila/LibreChat/discussions/13259). So
the Vertex rejection is real.

Vercel sends synthesized ids ungated, which by the above is the risky pattern; it
likely survives only because AI Studio tolerates arbitrary ids. Its own PR
([#15317](https://github.com/vercel/ai/commit/41da50cb), 2026-05-15) is instructive:
before it, Vercel discarded Gemini's id entirely and matched by name, noting _"This
does not cause any known bugs in production"_. Direct evidence that name-matching
works on the older path.

Worth noting LangChain JS's positional fallback is visibly broken under parallel
calls — it takes `prevMessage.tool_calls[0].name`, the _first_ call, with the
comment `// Hacky :(`. A good illustration of what name/position correlation costs.

The official google-genai SDK dispatches through a `name → callable` map and emits
responses in iteration order, so the happy path is entirely name-based.

**Does the Vertex risk apply to us?** No. VERIFIED locally: every Google module
defaults to `https://generativelanguage.googleapis.com/v1beta`
([Gemini.ts:163](../../packages/providers/google/src/Gemini.ts#L163)), the AI Studio
surface. `baseUrl` is overridable but there is no Vertex code path (Vertex needs
different auth and URL structure). So echoing `id` is safe for our shipped
configuration.

## Design conclusion

Our schema is **not** wrong. The rule the whole ecosystem converged on:

> **A tool call id is required in the domain model, but provider-optional on the
> wire.** Every SDK surveyed needs one internally to associate a result with a call
> (especially under parallel calls) and every one is prepared to mint it. What
> cannot be required is that it round-trips through the provider.

A shared `synthesizeCallId` in core is still the **wrong abstraction**: it would
serve the one provider whose format doesn't matter (Google), while the providers
where format does matter each need a value valid on their own wire. The contract
belongs in docs; each provider mints something valid for the wire it ships on.

The corollary, which our code already gets right on one side: **never leak a
synthesized id into a request where the server never issued one.** We guard the
outbound `functionCall` with `providerIdFor`
([codec.ts:362-365](../../packages/providers/google/src/codec.ts#L362-L365)), so
only real Gemini ids go out. The same guard is what makes the `functionResponse`
fix safe.

## Fix list

1. **Gemini `functionResponse.id`.** Add `id` to the `functionResponse` request
   part, populated via the same `providerIdFor` guard used on `functionCall`:
   present only when Gemini itself issued one. Pre-Gemini-3 keeps emitting
   name-only (correct, and matches google-genai's own behavior); Gemini 3 gets the
   strict id matching its docs require. Silent mis-pairing under parallel calls is
   the worst failure mode found in this research.
2. **Mistral fallback.** `` `call_${index}` `` → a 9-char alphanumeric value.
   Justified defensively: `id` is genuinely not required on the Mistral wire.
3. **Document the `call_id` contract in core**: required in domain, provider-optional
   on wire, local handle for some providers and a wire value for others.
4. ~~Anthropic `""`~~ — dropped. `id` is verified always present, so it never fires.

Deliberately **not** doing: cross-provider id normalization inside any codec. That
stays an opt-in helper if and when someone needs it. Note this now has a second use
case beyond the fallback recipe: OpenRouter passes upstream ids through verbatim,
so switching models within OpenRouter reproduces the same failure without crossing
a provider boundary from our layer's point of view.
