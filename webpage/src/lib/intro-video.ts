export type Chapter = {
  /** Offset in seconds. */
  readonly at: number
  readonly label: string
}

export const INTRO_CHAPTERS: ReadonlyArray<Chapter> = [
  { at: 0, label: "Capabilities, providers, recipes, and the coding agent skill" },
  { at: 506, label: "Why: how typical SDKs hide the request loop behind callbacks" },
  { at: 802, label: "The loop primitive and the basic usage recipe: tools, turns, onTurnComplete" },
  { at: 1578, label: "Model escalation with a signal tool" },
  { at: 1910, label: "Voice loop: speech to text, language model, text to speech, all streams" },
  { at: 2245, label: "Vercel AI SDK useChat frontend with live metrics and model fallback" },
]
