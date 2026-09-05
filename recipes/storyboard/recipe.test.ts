import { describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { expect } from "vitest"
import { imageBase64 } from "@effect-uai/core/Image"
import { ImageGenerator } from "@effect-uai/core/ImageGenerator"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type * as Turn from "@effect-uai/core/Turn"
import { board, type BoardConfig, isPanelReady } from "./recipe.js"

const cfg: BoardConfig = {
  style: "Style: flat colour comic art.",
  sheets: [
    { id: "pilar", description: "Character sheet. A girl in a red hat." },
    { id: "mo", description: "Character sheet. A ginger cat." },
    { id: "harbour", description: "Location sheet. A fishing harbour." },
  ],
  beats: [
    { page: 1, shot: "Wide. Pilar cycling along the quay." },
    { page: 2, shot: "Close on her hands." },
  ],
  imageModel: "mock-image",
  llmModel: "mock-llm",
  // Serial, so the scripted LLM turns line up with the panels that consume them.
  concurrency: 1,
  rounds: 1,
}

/** A scripted structured answer: the mock streams `output_text` verbatim. */
const answer = (value: unknown): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
})

// One scene, two panels in it. Panel 1 needs the girl and the cat; panel 2
// is a close-up of hands. The place is the scene's, never a shot's.
const shots = answer({
  scenes: [{ id: "quay", description: "The harbour at noon.", sheets: ["harbour"] }],
  shots: [
    {
      panel: 1,
      prompt: "Wide. Cycling along the quay.",
      sheets: ["pilar", "mo"],
      aspect: "3:2",
      scene: "quay",
    },
    { panel: 2, prompt: "Close on her hands.", sheets: ["pilar"], aspect: "1:1", scene: "quay" },
  ],
})

const verdict = (ok: boolean, note = "") => answer({ ok, note })

type Call = {
  readonly kind: "generate" | "edit"
  readonly prompt: string
  readonly refs: number
  readonly aspect: string | undefined
}

const imageMock = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([])
  const record = (call: Call) => Ref.update(calls, (xs) => [...xs, call])
  const layer = Layer.succeed(ImageGenerator, {
    generate: (request) =>
      Effect.as(
        record({
          kind: "generate",
          prompt: request.prompt,
          refs: 0,
          aspect: request.aspectRatio,
        }),
        { images: [{ image: imageBase64("sheet", "image/png") }], usage: {} },
      ),
    edit: (request) =>
      Effect.as(
        record({
          kind: "edit",
          prompt: request.prompt,
          refs: request.images.length,
          aspect: request.aspectRatio,
        }),
        { images: [{ image: imageBase64("panel", "image/png") }], usage: {} },
      ),
    streamGeneration: () => Effect.die("not used") as never,
  })
  return { layer, calls }
})

const run = (turns: ReadonlyArray<Turn.Turn>) =>
  Effect.gen(function* () {
    const { layer: image, calls } = yield* imageMock
    const events = yield* board(cfg).pipe(
      Stream.runCollect,
      Effect.provide(Layer.merge(image, MockProvider.layer(turns))),
    )
    return {
      events,
      panels: events.flatMap((e) => (isPanelReady(e) ? [e.panel] : [])),
      calls: yield* Ref.get(calls),
    }
  })

describe("board", () => {
  it.effect("casts, stages, then draws each panel from the scene and its own sheets", () =>
    Effect.gen(function* () {
      const { panels, calls } = yield* run([shots, verdict(true), verdict(true)])

      // Sheets are generated, then the scene is edited from its location
      // sheet, and only then are panels drawn: neither stage can reference
      // an image that does not exist yet.
      expect(calls.slice(0, 3).map((c) => c.kind)).toEqual(["generate", "generate", "generate"])
      const edits = calls.filter((c) => c.kind === "edit")
      // The scene: one reference, its location sheet.
      expect(edits[0]!.refs).toBe(1)
      // Panel 1 carries the scene plus its two sheets. Panel 2 carries the
      // scene, the panel before it, and its one sheet: the chain is what
      // makes it a sequence, the fixed anchors are what stop it drifting.
      expect(edits.slice(1).map((e) => e.refs)).toEqual([3, 3])
      // Panel shape is the director's, per shot; sheets stay square whatever
      // it picks, because they are references and not frames.
      expect(edits.slice(1).map((e) => e.aspect)).toEqual(["3:2", "1:1"])
      // `page` comes from the beat the shot's 1-based `panel` addresses.
      expect(panels.map((p) => p.page)).toEqual([1, 2])
    }),
  )

  it.effect("re-renders a rejected panel from the sheets, carrying the critic's note", () =>
    Effect.gen(function* () {
      const { panels, calls } = yield* run([
        shots,
        verdict(false, "The hat is blue, not red."),
        verdict(true),
        verdict(true),
      ])

      // One scene plus three panel draws: only the rejected panel is redone.
      const panelEdits = calls.filter((c) => c.kind === "edit").slice(1)
      expect(panelEdits).toHaveLength(3)
      // The redo comes straight after the attempt it replaces, not at the
      // end: each panel finishes its render-judge-redo loop before the next
      // panel starts, because the next panel is drawn from this one.
      expect(panelEdits[1]!.prompt).toContain("The hat is blue, not red.")
      // It re-renders from the same fixed references, not from the frame
      // that failed, so the rejected take's mistakes cannot carry.
      expect(panelEdits[1]!.refs).toBe(3)
      expect(panels.map((p) => p.rejected)).toEqual([undefined, undefined])
    }),
  )

  it.effect("ships a panel the critic keeps rejecting rather than looping forever", () =>
    Effect.gen(function* () {
      // Panel 1 fails both attempts; panel 2 passes.
      const { panels, calls } = yield* run([
        shots,
        verdict(false, "Still the wrong hat."),
        verdict(false, "Still the wrong hat."),
        verdict(true),
      ])

      // `rounds: 1` means one redo, so panel 1 stops after two attempts and
      // ships flagged instead of retrying forever. Four edits: the scene,
      // panel 1 twice, panel 2 once.
      expect(calls.filter((c) => c.kind === "edit")).toHaveLength(4)
      expect(panels[0]!.rejected).toBe("Still the wrong hat.")
      expect(panels[1]!.rejected).toBeUndefined()
    }),
  )
})
