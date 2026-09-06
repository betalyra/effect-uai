# @effect-uai/chat-completions

## 0.14.0

### Patch Changes

- a7e3bc6: Images inside a language-model turn. Some models answer with a picture rather
  than only text, and "make it dawn instead" changes that same picture, so the
  image belongs on the turn instead of behind a separate call.

  - **`output_image`** joins the `ContentBlock` union: a block on the assistant's
    message carrying the same `ImageSource` an `input_image` does.
    `Turn.assistantImages` pulls them out in order. Do not count on the text
    alongside it, since these models often return none.
  - **`ImageOutput`** joins `TurnEvent`, with `partialIndex` set only on a
    preview frame. It also lands on `TurnComplete.turn`, so reading the
    assembled turn misses nothing.
  - **`Turn.imagesAsInput`** restates assistant-drawn images as a following user
    message of `input_image` blocks. Explicit rather than automatic, because
    "the assistant drew this" and "here is an image, look at it" are not the
    same claim.
  - **`Capabilities.warnDroppedBlocks`** reports content a wire has no slot for,
    counted per request.
  - Only Gemini's wire carries an assistant-drawn image, so replaying one there
    is what lets a follow-up edit it. Every other adapter drops the block on
    replay and warns once per request, naming `imagesAsInput` as the way to
    resend it.

  See [images in a turn](https://effect-uai.betalyra.com/language-models/images-in-turns/).

## 0.13.0

## 0.12.1

## 0.12.0

## 0.11.0

Initial release. A reusable OpenAI Chat Completions (`POST /chat/completions`)
`LanguageModel` base for `@effect-uai/core`: SSE streaming, tools, and
structured output over the legacy chat dialect. Point it at any compatible
endpoint with `baseUrl` (OpenRouter, Requesty, Groq, Together, self-hosted).

Prefer `@effect-uai/responses` when the endpoint speaks the Responses protocol;
this dialect exists for endpoints that do not.
