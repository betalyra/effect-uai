/**
 * Gemini Live speech-to-speech Layer. Registers the typed `GeminiLiveSession`
 * tag, the generic `RealtimeSession` tag, and the `RealtimeVideoInput` marker,
 * which makes `sendVideoFrame` compile against this provider and not against
 * one without video.
 *
 * Auth rides on the URL, so this runs anywhere a `WebSocket` global exists:
 * Node, Bun, Deno and the browser, with no peer dependency.
 */
import { Context, Effect, Layer, type Scope } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import type { CommonSessionRequest } from "@effect-uai/core/Realtime"
import {
  RealtimeSession,
  type RealtimeSessionHandle,
  type RealtimeSessionService,
  RealtimeVideoInput,
} from "@effect-uai/core/RealtimeSession"
import { type Config, type GeminiLiveRequest, openSession } from "./realtimeSession.js"

export type { Config, GeminiLiveRequest } from "./realtimeSession.js"

export type GeminiLiveSessionService = {
  readonly open: (
    request: GeminiLiveRequest,
  ) => Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope>
}

export class GeminiLiveSession extends Context.Service<
  GeminiLiveSession,
  GeminiLiveSessionService
>()("@betalyra/effect-uai/providers/google/GeminiLiveSession") {}

export const make = (cfg: Config): GeminiLiveSessionService => ({ open: openSession(cfg) })

export const layer = (
  cfg: Config,
): Layer.Layer<GeminiLiveSession | RealtimeSession | RealtimeVideoInput> =>
  Layer.mergeAll(
    Layer.succeed(GeminiLiveSession, make(cfg)),
    Layer.succeed(RealtimeSession, {
      open: (request: CommonSessionRequest) => make(cfg).open(request as GeminiLiveRequest),
    } satisfies RealtimeSessionService),
    Layer.succeed(RealtimeVideoInput, undefined),
  )
