import type { DateTime } from "effect"

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * A document the model consulted. `url` and `title` are the only
 * near-universal fields; the rest is best-effort. `raw` round-trips
 * provider-opaque tokens (encrypted indices, chunk handles, document ids) so
 * nothing is lost.
 */
export type Source = {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedDate?: DateTime.DateTime
  readonly sourceType?: "web" | "x" | "news" | "file" | "document" | (string & {})
  readonly raw?: unknown
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

/**
 * Where in the answer a claim is grounded, and which sources ground it.
 * `sourceRefs` indexes into the sibling {@link Citations.sources} array
 * (many-to-one). The four kinds normalize how providers link answer text to
 * sources: a character / byte offset range, an exact source quote, a
 * positional `[n]` marker, or `none` for a bare source with no anchor.
 */
export type CitationSpan =
  | {
      readonly kind: "char"
      readonly start: number
      readonly end: number
      readonly unit: "char" | "byte"
      readonly sourceRefs: ReadonlyArray<number>
      readonly confidence?: number
    }
  | { readonly kind: "quote"; readonly text: string; readonly sourceRefs: ReadonlyArray<number> }
  | {
      readonly kind: "marker"
      readonly ordinal: number
      readonly sourceRefs: ReadonlyArray<number>
    }
  | { readonly kind: "none"; readonly sourceRefs: ReadonlyArray<number> }

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * The grounding for a piece of generated text: the sources consulted, and the
 * spans that reference them. This is the canonical, provider-agnostic form.
 * The flat `Items.Annotation` array is its degenerate view (one `char` span
 * with one inlined source), used where a wire-attached, per-`output_text`
 * shape is enough.
 */
export type Citations = {
  readonly sources: ReadonlyArray<Source>
  readonly spans: ReadonlyArray<CitationSpan>
}
