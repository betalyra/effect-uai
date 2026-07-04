import { Context, type Duration, Effect } from "effect"
import type * as AiError from "../domain/AiError.js"

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Representation to return for a page. `markdown` is the default. */
export type ReadFormat = "markdown" | "html"

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Cross-provider read request: one URL in, clean content out. Provider-specific
 * knobs live on the provider-typed request.
 */
export type CommonReadRequest = {
  /** The page to read. */
  readonly url: string
  /** Output representation. Defaults to `markdown`. See {@link ReadFormat}. */
  readonly format?: ReadFormat
  /** Upper bound on time spent fetching the page. */
  readonly timeout?: Duration.Duration
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** One normalized read result. */
export type ReadResponse = {
  /** The URL that was read. */
  readonly url: string
  /** Extracted content in the requested {@link ReadFormat}. */
  readonly content: string
  /** Page title, when reported. */
  readonly title?: string
  /** Links discovered on the page, when returned. */
  readonly links?: ReadonlyArray<string>
  /** The provider-native response. */
  readonly raw: unknown
}

// ---------------------------------------------------------------------------
// Service + helper
// ---------------------------------------------------------------------------

/**
 * The portable read surface: one operation, `read`. Every implementor can
 * answer, so this capability needs no marker tags.
 */
export type WebReadService = {
  readonly read: (request: CommonReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
}

/**
 * Generic read service tag. Yield this for provider-portable code; yield a
 * provider tag for provider-specific knobs. A provider `layer` registers both.
 */
export class WebRead extends Context.Service<WebRead, WebReadService>()(
  "@betalyra/effect-uai/WebRead",
) {}

/** Read one URL against whichever provider Layer is in scope. */
export const read = (
  request: CommonReadRequest,
): Effect.Effect<ReadResponse, AiError.AiError, WebRead> =>
  Effect.flatMap(WebRead.asEffect(), (s) => s.read(request))
