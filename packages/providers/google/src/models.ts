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

/**
 * Known Gemini image-generation model identifiers. The `-preview` ids
 * were shut down 2026-06-25 and are not listed; neither is the
 * previous-generation `gemini-2.5-flash-image`, which the `(string & {})`
 * tail still accepts.
 *
 * - `gemini-3.1-flash-image` — 512 / 1K / 2K / 4K, web and image search.
 * - `gemini-3.1-flash-lite-image` — 1K only, cheapest, no search.
 * - `gemini-3-pro-image` — 1K / 2K / 4K, the most reference images.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/models
 */
export type GeminiImageModel =
  | "gemini-3.1-flash-image"
  | "gemini-3.1-flash-lite-image"
  | "gemini-3-pro-image"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Deep-research agent identifiers for the Interactions API (`POST
 * /v1beta/interactions`). `-preview` is the fast tier, `-max-` the
 * comprehensive one. Preview surface: verify against live docs before relying on
 * exact ids. The `(string & {})` tail accepts any string so a renamed agent
 * works without an SDK update.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/interactions/deep-research
 */
export type GoogleDeepResearchModel =
  | "deep-research-preview-04-2026"
  | "deep-research-max-preview-04-2026"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Known Gemini embedding model identifiers.
 *
 * - `gemini-embedding-2` — natively multimodal (text, image, audio, video,
 *   PDF). Does *not* honour the `taskType` field; instead prepend a task
 *   instruction to the text yourself.
 * - `gemini-embedding-001` — text-only, supports the full `taskType` enum
 *   (`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` / classification / etc.).
 *
 * The `(string & {})` tail accepts any string so newly-released models
 * work without an SDK update.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/embeddings
 */
/**
 * Known Gemini TTS model identifiers. `(string & {})` tail keeps
 * autocomplete on the literals while still accepting any string.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/speech-generation
 */
export type GeminiTtsModel =
  | "gemini-2.5-flash-preview-tts"
  | "gemini-2.5-pro-preview-tts"
  | "gemini-3.1-flash-tts-preview"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * 30 prebuilt voice names for Gemini TTS. No custom-voice / cloning path
 * is exposed on this surface, so the tail is stock-only (no
 * `(string & {})` escape).
 *
 * Reference: https://ai.google.dev/gemini-api/docs/speech-generation
 */
export type GeminiVoiceName =
  | "Zephyr"
  | "Puck"
  | "Charon"
  | "Kore"
  | "Fenrir"
  | "Leda"
  | "Orus"
  | "Aoede"
  | "Callirrhoe"
  | "Autonoe"
  | "Enceladus"
  | "Iapetus"
  | "Umbriel"
  | "Algieba"
  | "Despina"
  | "Erinome"
  | "Algenib"
  | "Rasalgethi"
  | "Laomedeia"
  | "Achernar"
  | "Alnilam"
  | "Schedar"
  | "Gacrux"
  | "Pulcherrima"
  | "Achird"
  | "Zubenelgenubi"
  | "Vindemiatrix"
  | "Sadachbia"
  | "Sadaltager"
  | "Sulafat"

/**
 * Known Lyria (music generation) model identifiers. `(string & {})` tail
 * keeps autocomplete on the literals while still accepting any string.
 *
 * - `lyria-3-clip-preview` — fixed 30s output, MP3 only.
 * - `lyria-3-pro-preview` — up to a couple of minutes, MP3 or WAV.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/music-generation
 */
export type LyriaModel =
  | "lyria-3-clip-preview"
  | "lyria-3-pro-preview"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

export type GoogleEmbeddingModel =
  | "gemini-embedding-2"
  | "gemini-embedding-001"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
