import type * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import * as Input from "@effect-uai/ui/Input"
import { InputId, StreamId } from "@effect-uai/ui/RunEvent"
import * as Thread from "@effect-uai/ui/Thread"
import { describe, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { expect } from "vitest"
import { makeChats } from "./recipe.js"

const answer = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: {},
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

// Answers with how many history items it was given.
const countingAgent = (history: ReadonlyArray<Items.HistoryItem>) =>
  Stream.make(
    Turn.TurnEvent.TextDelta({ text: `saw ${history.length}` }),
    Turn.TurnEvent.TurnComplete({ turn: answer(`saw ${history.length}`) }),
  )

const message = (text: string, id: string) => ({ ...Input.submit(text), id: InputId.make(id) })

describe("direct-chat chats", () => {
  it.effect(
    "names the chat on the first run; later runs see the history and continue its seq",
    () =>
      Effect.gen(function* () {
        const chats = yield* makeChats(countingAgent)
        // What the client does per message: show it, send it with the thread's chat id, fold the answer.
        const ask = (thread: Thread.Thread, input: Input.Sent<Input.Submit>) =>
          chats.send(Option.fromNullishOr(thread.streamId), input).pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.map((frames) => ({
              frames,
              thread: frames.reduce(Thread.step, Thread.submitted(thread, input)),
            })),
          )

        const first = yield* ask(Thread.initial, message("first", "in_1"))
        const second = yield* ask(first.thread, message("second", "in_2"))

        const chatId = first.thread.streamId
        const frames = [...first.frames, ...second.frames]
        expect(frames.every((f) => f.streamId === chatId)).toBe(true)
        expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1))

        const thread = second.thread
        expect(thread.streamId).toBe(chatId)
        expect(
          thread.messages.map((m) => (m.role === "user" ? Input.text(m.value) : m.value.blocks)),
        ).toEqual([
          "first",
          [expect.objectContaining({ type: "output_text", text: "saw 1" })],
          "second",
          [expect.objectContaining({ type: "output_text", text: "saw 3" })],
        ])
      }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )

  it.effect("fails an unknown chat before anything streams", () =>
    Effect.gen(function* () {
      const chats = yield* makeChats(countingAgent)
      const error = yield* chats
        .send(Option.some(StreamId.make("nope")), message("hi", "in_1"))
        .pipe(Effect.flip)
      expect(error._tag).toBe("ChatNotFound")
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )
})
