---
title: Compatible endpoints
description: Reaching an OpenAI-shaped realtime gateway through baseUrl and headers.
---

Several vendors speak the OpenAI Realtime protocol on their own host.
Where they do, you reach them by pointing the OpenAI Layer somewhere
else rather than by installing another package.

```ts
import { layer as realtimeLayer } from "@effect-uai/openai/OpenAIRealtimeSession"

const xai = realtimeLayer({
  apiKey,
  baseUrl: "https://api.x.ai/v1",
})
```

`baseUrl` replaces the host and path, `headers` adds whatever the vendor
needs on the upgrade, and a query already on `baseUrl` is kept when the
socket URL is built. `webSocket` replaces the socket constructor
outright, which is how you route through a proxy.

> These endpoints are configuration, not tested integrations: the test
> suite covers OpenAI and Gemini only, and the notes below come from
> vendor documentation. Treat the first connection as the real test.

## xAI Grok Voice

`baseUrl: "https://api.x.ai/v1"`, bearer auth, models
`grok-voice-latest` and `grok-voice-think-fast-2.0`.

The closest fit: xAI ships the GA dialect with extensions. Two
deviations matter. Input transcripts arrive as
`conversation.item.input_audio_transcription.updated` and are
cumulative, which this adapter does not decode, so `InputTranscript`
stays silent. And xAI's `force_message`, for speaking a scripted line
without inference, has no equivalent in the common input union.

## Azure OpenAI Realtime

`baseUrl: "https://{resource}.openai.azure.com/openai/v1"`, the same
protocol verbatim, models `gpt-realtime-2` and friends.

Auth is the wrinkle: pass an Entra token as `apiKey` and it goes out as
the bearer Azure expects. For key auth, put `api-key` in `headers`
instead (the bearer header is sent regardless and ignored).

## Azure Voice Live

`baseUrl: "https://{resource}.services.ai.azure.com/voice-live?api-version=2026-04-10"`.

Voice Live pins its API version in the query, so put it on `baseUrl`
and it reaches the socket. It adds `azure_*` session fields the typed
request does not carry, along with viseme and avatar events the adapter
ignores. What works is the OpenAI subset: audio, tools, VAD,
truncation.

## What Will Not Work This Way

Providers whose wire is not OpenAI-shaped need their own adapter, not a
`baseUrl`. Gemini Live is the one that ships, at
[Gemini Live](/realtime/providers/gemini/); Amazon Nova Sonic, Hume EVI
and the WebRTC transports are not implemented.
