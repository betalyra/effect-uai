# @effect-uai/ai-sdk

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

### Minor Changes

- 1efb6b4: `@effect-uai/ai-sdk` joins the release train (fixed to the shared version).
  Vercel AI SDK compatibility: keep your `@ai-sdk/react` `useChat` frontend as it
  is and serve it from an effect-uai agent loop instead of `streamText`.
  - **`Messages.decodeMessages`**: turn the `UIMessage[]` a `useChat` client POSTs
    into effect-uai `HistoryItem`s.
  - **`UIMessageStream.toUIMessageStream`**: project the loop's `InteractionEvent`
    stream onto the AI SDK UI Message Stream protocol (`v1`) as `SSE.Event`s, with
    `dataPart` / `messageMetadata` emitters and the required `responseHeaders`.

  The package owns no HTTP layer: it produces a `Stream<SSE.Event>`, so it drops
  into any server. See the `examples/ai-sdk-next` Next.js chat route.
