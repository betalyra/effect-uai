import { Effect, Encoding, Match } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import type { VideoBytesSource, VideoSource } from "../domain/Video.js"
import { videoBytes } from "../domain/Video.js"

const DEFAULT_MIME = "video/mp4"

/** A fetch that failed, or a `base64` source that was not decodable. */
export type DownloadError = HttpClientError.HttpClientError | Encoding.EncodingError

type Download = Effect.Effect<VideoBytesSource, DownloadError, HttpClient.HttpClient>

/**
 * Read a {@link VideoSource} into memory. Opt-in: clips run to tens of
 * megabytes and providers' URLs expire, from about an hour to thirty days.
 *
 * Fails with the HTTP client's error rather than an `AiError`, since a plain
 * GET has no provider to name. Providers whose URLs carry auth resolve them
 * in their own adapter.
 */
export const download = (source: VideoSource): Download =>
  Match.value(source).pipe(
    Match.tag("bytes", (s): Download => Effect.succeed(s)),
    Match.tag("base64", (s): Download =>
      Effect.map(Effect.fromResult(Encoding.decodeBase64(s.base64)), (bytes) =>
        videoBytes(bytes, s.mimeType),
      ),
    ),
    Match.tag("url", (s): Download =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(s.url)
        const buffer = yield* response.arrayBuffer
        const served = response.headers["content-type"]?.split(";")[0]
        return videoBytes(new Uint8Array(buffer), served ?? s.mimeType ?? DEFAULT_MIME)
      }),
    ),
    Match.exhaustive,
  )
