# Provider options and provider state on items

Status: agreed direction, not started. Replaces the common
`Message.cacheBreakpoint` field proposed in #218 (issue #217).

## Problem

#218 adds `cacheBreakpoint: boolean` to every `Message`. Only Anthropic and
OpenAI (GPT-5.6+) support per-block breakpoints, and they behave differently:

- **Anthropic**: `cache_control` is allowed on any block. The TTL is chosen per
  breakpoint (5m or 1h) and longer TTLs must come first.
- **OpenAI**: `prompt_cache_breakpoint` is allowed on input blocks only. The
  TTL is set once per request (30m).

Gemini (separate cached-content resources), DeepSeek, xAI and Mistral (automatic
only) have no equivalent. A common field would promise behavior that most
providers silently ignore.

The obvious alternative, putting the hint in `providerData`, mixes two
directions in one slot. Today `providerData.responses` holds the stored wire
item that the Responses codec sends back verbatim. A caller-written hint under
the same key would be told apart from it only by its shape, and a helper that
sets the hint could overwrite round-trip state.

## Design

Split the slot by direction. Both slots are keyed by provider name, so items
still pass through several providers during a fallback.

| Slot | Written by | Read by | On |
|---|---|---|---|
| `providerState` | the codec, when it decodes a response | the same codec, on the next request | items (`Message`, `ToolCall`, `ToolCallOutput`, `Reasoning`) |
| `providerOptions` | the caller | the codec | content blocks and `Message` |

- `providerState` is today's `providerData`, renamed. Callers never touch it.
- `providerOptions` is input only. Codecs never write it, so it never shows up
  in a response, and it stays on the message across turns.
- Options sit on content blocks because both native APIs put breakpoints on
  blocks. There is no "last block of the message" rule hidden in codecs.

### Typing

This follows effect's own `ai/Prompt` module. Core defines one options interface
per block kind. Each extends a base record, so it keeps an index signature and
stays assignable to the Schema type. Provider packages augment the interfaces
that apply to them:

```ts
// core: Items.ts
export const ProviderOptions = Schema.Record(Schema.String, Schema.Unknown)
export interface InputTextOptions extends Schema.Schema.Type<typeof ProviderOptions> {}
export interface InputImageOptions extends Schema.Schema.Type<typeof ProviderOptions> {}
export interface OutputTextOptions extends Schema.Schema.Type<typeof ProviderOptions> {}
export interface MessageOptions extends Schema.Schema.Type<typeof ProviderOptions> {}

// @effect-uai/responses: input blocks only, so OutputTextOptions is not augmented
declare module "@effect-uai/core/Items" {
  interface InputTextOptions { readonly responses?: { readonly promptCacheBreakpoint?: boolean } }
  interface InputImageOptions { readonly responses?: { readonly promptCacheBreakpoint?: boolean } }
}
```

What each layer checks:
- **Known provider keys** are typed by the augmentation. Where a provider can't
  take an option, using it there is a type error.
- **Unknown keys** still compile, because of the index signature.
- **At runtime**, each codec decodes its own key with Schema. A value that fails
  to decode fails the request with `InvalidRequest`; it is never dropped.

### Usage

```ts
const history = [
  Items.systemText(longSharedPrompt, {
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      responses: { promptCacheBreakpoint: true },
    },
  }),
  Items.userText(question),
]
```

## Steps

1. **Core** ([Items.ts](../packages/core/src/domain/Items.ts))
   - Rename `providerData` to `providerState` on the four item types.
   - Add the options interfaces and the `providerOptions` field to every
     content block and to `Message`.
   - Add an optional `{ providerOptions }` argument to `userText`, `systemText`
     and `assistantText`.
   - `providerData` on image-generation results (`Image.ts`,
     `ImageGenerator.ts`) is output metadata, not round-trip state. Leave it.
2. **Rename at call sites**: responses, google, openai realtime, their tests,
   and the recipe tests that build items with `providerData`.
3. **Anthropic** (reuses the #218 codec work)
   - Augment `InputTextOptions`, `InputImageOptions` and `OutputTextOptions`
     with `anthropic.cacheControl`, and write it per block.
   - **System**: if any system block has `cacheControl`, send `system` as text
     blocks instead of the joined string.
   - **Assistant**: encode one wire block per content block instead of joining
     with `messageText`, so a marker on a middle block lands where it was
     placed.
   - The layer-level `promptCaching` stays as is. Document that keeping TTLs in
     order is the caller's job.
4. **Responses**
   - Augment `InputTextOptions` and `InputImageOptions` with
     `responses.promptCacheBreakpoint`, and encode it as
     `prompt_cache_breakpoint: { mode: "explicit" }`.
   - Read state from `providerState.responses` only.
5. **Docs**
   - `items-and-turns.md`: the two slots and who writes each.
   - Provider pages: caching sections in `anthropic.md` and `responses.md`.
   - A migration note for the rename, in the style of
     [v0-12.md](../docs/migrations/v0-12.md).
6. **Changeset**: a breaking change in core, plus every package touched by the
   rename.

Chat Completions (OpenAI explicit breakpoints, and OpenRouter's `cache_control`
passthrough) can follow the same pattern later.

## Open questions

- Should `ToolCallOutput` get `providerOptions` in this change? Anthropic accepts
  `cache_control` on `tool_result`, and OpenAI documents breakpoints on
  `function_call_output` text but reportedly never writes the cache there.
  Proposal: leave it out until someone needs it.
- Module augmentation is new to this repo. Spike it first to confirm that the
  augmentation applies when the user imports only the provider's layer.
