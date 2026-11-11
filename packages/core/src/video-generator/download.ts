import { Effect, Match, Option, Stream } from "effect"
import { Base64, type EncodingError } from "effect/encoding"
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http"
import * as AiError from "../domain/AiError.js"
import type { VideoSource } from "../domain/Video.js"

/**
 * Who reads, and what to send along. `headers` is for providers whose file
 * URLs need auth; send them only for the provider's own host.
 */
export type ReadOptions = {
  readonly provider: string
  readonly headers?: Readonly<Record<string, string>>
}

const httpFailure =
  (provider: string) =>
  (error: HttpClientError.HttpClientError): AiError.AiError =>
    Option.match(Option.fromNullishOr(error.response?.status), {
      onNone: () => new AiError.Unavailable({ provider, raw: error }),
      onSome: (status) =>
        Match.value(status).pipe(
          Match.when(429, () => new AiError.RateLimited({ provider, raw: error })),
          Match.when(
            (s) => s >= 500,
            () => new AiError.Unavailable({ provider, status, raw: error }),
          ),
          // Mostly an expired link: provider URLs live an hour to thirty days.
          Match.orElse(() => new AiError.InvalidRequest({ provider, param: "video", raw: error })),
        ),
    })

const decodeFailure =
  (provider: string) =>
  (error: EncodingError.EncodingError): AiError.AiError =>
    new AiError.GenerationFailed({ provider, message: "video base64 is not decodable", raw: error })

/**
 * The building block a provider's `read` delegates to: a `url` source
 * streamed over HTTP (non-2xx fails), `base64` decoded, `bytes` as is. A
 * `ref` fails `Unsupported`: only its own provider can resolve it, so a
 * provider handles its refs before delegating the rest here.
 * Applications read through `VideoGenerator.toStream` / `toBytes`, which
 * route to the provider that produced the video.
 */
export const read = (
  source: VideoSource,
  options: ReadOptions,
): Stream.Stream<Uint8Array, AiError.AiError, HttpClient.HttpClient> =>
  Match.value(source).pipe(
    Match.tag("bytes", (s) => Stream.succeed(s.bytes)),
    Match.tag("ref", (s) =>
      Stream.fail(
        new AiError.Unsupported({
          provider: options.provider,
          capability: "read",
          reason: `A ${s.provider} file reference is read by ${s.provider}, not ${options.provider}.`,
        }),
      ),
    ),
    Match.tag("base64", (s) =>
      Stream.fromEffect(
        Effect.fromResult(Base64.decode(s.base64)).pipe(
          Effect.mapError(decodeFailure(options.provider)),
        ),
      ),
    ),
    Match.tag("url", (s) =>
      Stream.unwrap(
        HttpClient.get(s.url, { headers: options.headers ?? {} }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.map((response) => response.stream),
        ),
      ).pipe(Stream.mapError(httpFailure(options.provider))),
    ),
    Match.exhaustive,
  )
