/**
 * Cross-modality media reference shape.
 *
 * Every "media at rest" reference - image, audio, video, document - is one
 * of three variants:
 *
 *   - `url`    : a remote address (HTTP, GCS, etc.). The model fetches it.
 *               `mimeType` is optional - servers usually set Content-Type.
 *               Some providers (Gemini `fileData`) want it explicit.
 *
 *   - `base64` : an inline base64-encoded payload. Always carries a
 *               `mimeType` so the consumer knows how to decode.
 *
 *   - `bytes`  : raw `Uint8Array`. Provider layers normalize to base64 or
 *               multipart upload at the wire boundary - users don't need
 *               to encode themselves.
 *
 * Per-modality files (`Image.ts`, future `Audio.ts` / `Video.ts` /
 * `Document.ts`) instantiate this shape with their typed MIME union to
 * get autocomplete on common formats while keeping the structural type
 * uniform across modalities.
 *
 * Streaming media (live mic feed, streaming TTS playback) is *not*
 * modeled here. Streams carry effect parameters (`Stream<A, E, R>`) and
 * lifecycle (Scope, cancellation) that don't apply to media at rest. The
 * complementary type lives alongside this one as `*Stream` in each
 * per-modality file when those modalities land.
 *
 * Provider-uploaded asset references (OpenAI Files `file_id`, Gemini
 * Files API URIs, Anthropic file IDs) are also out of scope here -
 * they're a separate union (`FileRef`) added when needed.
 */

/**
 * Watermark kind a provider embedded in generated media. Shared across
 * modalities (audio, image). No provider exposes metadata beyond the
 * kind, so a bare literal union is enough.
 */
export type Watermark = "synthid" | "c2pa" | (string & {})

/**
 * Requested shape of generated visual media, width to height. Shared by
 * image and video generation: the listed ratios are the ones providers
 * accept as literals, and the `(string & {})` tail keeps a
 * newly-supported ratio working without an SDK update. Which ratios a
 * given model accepts is not checked here; the provider rejects what it
 * cannot render and the adapter translates that error.
 *
 * Resolution is NOT shared: image models tier by short edge
 * (`ImageResolution`), video models by scan height. Each modality types
 * its own.
 */
export type AspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9"
  | "1:4"
  | "4:1"
  | "1:8"
  | "8:1"
  | (string & {})

export type MediaUrl<M extends string = string> = {
  readonly _tag: "url"
  readonly url: string
  readonly mimeType?: M
}

export type MediaBase64<M extends string = string> = {
  readonly _tag: "base64"
  readonly base64: string
  readonly mimeType: M
}

export type MediaBytes<M extends string = string> = {
  readonly _tag: "bytes"
  readonly bytes: Uint8Array
  readonly mimeType: M
}

export type MediaSource<M extends string = string> = MediaUrl<M> | MediaBase64<M> | MediaBytes<M>

export const isMediaUrl = <M extends string>(s: MediaSource<M>): s is MediaUrl<M> =>
  s._tag === "url"

export const isMediaBase64 = <M extends string>(s: MediaSource<M>): s is MediaBase64<M> =>
  s._tag === "base64"

export const isMediaBytes = <M extends string>(s: MediaSource<M>): s is MediaBytes<M> =>
  s._tag === "bytes"
