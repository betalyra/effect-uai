# @effect-uai/ai-sdk

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
