/**
 * OpenAI Realtime speech-to-speech Layer. Registers the typed
 * `OpenAIRealtimeSession` tag and the generic `RealtimeSession` tag.
 *
 * No `RealtimeVideoInput` marker: OpenAI Realtime takes still images as
 * conversation items but has no video input, so `sendVideoFrame` against this
 * Layer alone is a compile error.
 *
 * Pulls in `ws` (peer dep) transitively. Node and Bun only, since the browser
 * `WebSocket` API cannot set the `Authorization` header.
 */
import { Context, Effect, Layer, type Scope } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import type { CommonSessionRequest } from "@effect-uai/core/Realtime"
import {
  RealtimeSession,
  type RealtimeSessionHandle,
  type RealtimeSessionService,
} from "@effect-uai/core/RealtimeSession"
import {
  type Config,
  type OpenAIRealtimeRequest,
  openSession,
  refuseResume,
} from "./realtimeSession.js"

export type { Config, OpenAIRealtimeRequest } from "./realtimeSession.js"

export type OpenAIRealtimeSessionService = {
  readonly open: (
    request: OpenAIRealtimeRequest,
  ) => Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope>
}

export class OpenAIRealtimeSession extends Context.Service<
  OpenAIRealtimeSession,
  OpenAIRealtimeSessionService
>()("@betalyra/effect-uai/providers/openai/OpenAIRealtimeSession") {}

export const make = (cfg: Config): OpenAIRealtimeSessionService => ({ open: openSession(cfg) })

export const layer = (cfg: Config): Layer.Layer<OpenAIRealtimeSession | RealtimeSession> =>
  Layer.mergeAll(
    Layer.succeed(OpenAIRealtimeSession, make(cfg)),
    Layer.succeed(RealtimeSession, {
      open: (request: CommonSessionRequest) =>
        Effect.andThen(refuseResume(request), make(cfg).open(request as OpenAIRealtimeRequest)),
    } satisfies RealtimeSessionService),
  )
