---
"@effect-uai/openai": minor
"@effect-uai/core": minor
---

Add `@effect-uai/openai/OpenAIRealtimeSession`, the first `RealtimeSession` provider.

`layer({ apiKey, baseUrl?, region?, headers?, webSocket? })` registers the typed `OpenAIRealtimeSession` tag and the generic `RealtimeSession` tag over one WebSocket on `wss://api.openai.com/v1/realtime?model=`. No `RealtimeVideoInput` marker: OpenAI Realtime takes still images as conversation items but has no video input, so `sendVideoFrame` against this layer alone is a compile error rather than a runtime failure.

- `open` connects, waits for `session.created`, sends `session.update` and waits for `session.updated` before it succeeds, so a session that the server rejects fails at wiring time rather than as a stream that dies a moment later. Closing the scope closes the socket, and `send` afterwards fails `Unavailable`.
- A close never synthesizes a `ResponseDone`. A close while a response is generating ends the stream with `IncompleteTurn`; a clean close between responses simply ends it.
- Barge-in surfaces as `SpeechStarted` then `Interrupted`, before the cancelled `ResponseDone`, and unanswered calls of that response arrive as `ToolCallCancelled`. `PlaybackPosition` truncates the assistant item at what the listener actually heard. That item outlives its response on purpose: the model generates far faster than real time, so a position usually arrives for an answer the server already finished, and forgetting the item at `response.done` would drop the truncate that matters most.
- Answering a tool resumes generation, but only one response may be active at a time, so a result that lands while the model is already speaking waits for that response to finish before its turn is asked for. A slow tool routinely answers after the user has spoken again, and without the wait the result would sit unread in the conversation.
- A tool call is named from the item that announced it, since the arguments frame carries no name. Answering with a `ToolResult` writes the `function_call_output` and asks for the follow-up turn, so the caller never sends `response.create`. A result for a call this session never made fails `InvalidRequest`.
- `OpenAIRealtimeRequest` narrows `model` to `gpt-realtime-2.1` and friends and adds the provider-shaped knobs: `turnDetectionConfig` (server or semantic VAD), `noiseReduction`, `truncation`, `reasoningEffort`, `maxOutputTokens`, `speed`, `outputModalities` and `transcriptionModel`. `baseUrl`, `headers` and `webSocket` are what make a compatible gateway or a proxied socket reachable, and a query already on `baseUrl` survives onto the socket URL, which is what a gateway pinning an API version there needs.

In `@effect-uai/core`, two supporting pieces: `@effect-uai/core/WebSocketSession` is one JSON-over-WebSocket session (connect, decoded frames off a queue, write frames back) with `SocketError` mapped to `AiError`, and `@effect-uai/core/testing/FakeWebSocket` is an in-memory socket for testing adapters without a server, where the scripted server is a forked fiber and `reply` is a real Effect. The seven older stream-shaped adapters still carry their own copies of the connect logic.
