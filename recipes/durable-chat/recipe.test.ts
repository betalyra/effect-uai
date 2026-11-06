import type * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import * as Input from "@effect-uai/ui/Input"
import { type Envelope, InputId, isTerminal } from "@effect-uai/ui/RunEvent"
import { describe, it } from "@effect/vitest"
import { Deferred, Effect, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { expect } from "vitest"
import { makeChats } from "./recipe.js"

const answer = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: {},
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

// Answers with how many history items it was given, after `gate` opens.
const countingAgent =
  (gate: Deferred.Deferred<void>) => (history: ReadonlyArray<Items.HistoryItem>) =>
    Stream.fromEffectDrain(Deferred.await(gate)).pipe(
      Stream.concat(
        Stream.make(
          Turn.TurnEvent.TextDelta({ text: `saw ${history.length}` }),
          Turn.TurnEvent.TurnComplete({ turn: answer(`saw ${history.length}`) }),
        ),
      ),
    )

const message = (text: string, id: string) => ({ ...Input.submit(text), id: InputId.make(id) })

// The chat stream never ends: read it until `runs` runs have finished.
const readRuns = (runs: number) => (stream: Stream.Stream<Envelope>) =>
  stream.pipe(
    Stream.mapAccum(
      () => 0,
      (done, e) => {
        const next = isTerminal(e.event) ? done + 1 : done
        return [next, [[next, e] as const]] as const
      },
    ),
    Stream.takeUntil(([done]) => done === runs),
    Stream.map(([, e]) => e),
    Stream.runCollect,
  )

const texts = (frames: ReadonlyArray<Envelope>) =>
  frames.flatMap((f) => (f.event.type === "text-delta" ? [f.event.text] : []))

const settle = "10 millis"

const started = (stream: Stream.Stream<Envelope>) =>
  stream.pipe(
    Stream.filter((f) => f.event.type === "run-started"),
    Stream.runHead,
  )

describe("durable-chat chats", () => {
  it.live("answers a burst in one run that sees the whole history, on one seq", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      yield* Deferred.succeed(gate, undefined)
      const chats = yield* makeChats(countingAgent(gate), { settle })

      const chatId = yield* chats.send(Option.none(), message("first", "in_1"))
      yield* chats.events(chatId, 0).pipe(Effect.flatMap(readRuns(1)))
      yield* chats.send(Option.some(chatId), message("second", "in_2"))
      yield* chats.send(Option.some(chatId), message("third", "in_3"))

      const frames = yield* chats.events(chatId, 0).pipe(Effect.flatMap(readRuns(2)))
      // One run for the burst; it saw: first question, first answer, second, third.
      expect(texts(frames)).toEqual(["saw 1", "saw 4"])
      expect(
        frames.flatMap((f) => (f.event.type === "run-started" ? [f.event.inputs] : [])),
      ).toEqual([["in_1"], ["in_2", "in_3"]])
      expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1))
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )

  it.live("queues a message sent during a run; stop ends only the running one", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const chats = yield* makeChats(countingAgent(gate), { settle })
      const chatId = yield* chats.send(Option.none(), message("first", "in_1"))
      yield* chats.events(chatId, 0).pipe(Effect.flatMap(started))
      yield* chats.send(Option.some(chatId), message("second", "in_2"))

      yield* chats.stop(chatId)
      yield* Deferred.succeed(gate, undefined)
      const frames = yield* chats.events(chatId, 0).pipe(Effect.flatMap(readRuns(2)))

      // Inputs are echoed when queued, stream-scoped (no runId).
      expect(frames.filter((f) => f.event.type === "input-accepted").map((f) => f.runId)).toEqual([
        undefined,
        undefined,
      ])
      expect(frames.flatMap((f) => (isTerminal(f.event) ? [f.event.type] : []))).toEqual([
        "run-stopped",
        "run-completed",
      ])
      // The stopped run left no answer: the second saw both questions only.
      expect(texts(frames)).toEqual(["saw 2"])
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )
})
