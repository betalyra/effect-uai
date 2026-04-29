/**
 * Known Gemini model identifiers (as of April 2026). The `(string & {})`
 * tail keeps autocomplete on the literals while still accepting any string,
 * so newly-released models work without an SDK update.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */
export type GoogleModel =
  | "gemini-3.1-pro-preview"
  | "gemini-3-flash-preview"
  | "gemini-3.1-flash-lite-preview"
  | "gemini-3.1-flash-live-preview"
  | "gemini-3.1-flash-tts-preview"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
