import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, PubSub, Ref, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Atom, AtomRegistry } from "effect/reactivity"
import { expect } from "vitest"
import * as Atoms from "./Atoms.js"
import * as Input from "./Input.js"
import * as Run from "./Run.js"
import { type Envelope, type InputId, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import type * as Thread from "./Thread.js"
import * as Transport from "./Transport.js"

const runtime = Atom.runtime(SecureRandom.layerWebCrypto)

const reply = (inputId: InputId): ReadonlyArray<RunEvent> => [
  { type: "run-started", runId: RunId.make("r1"), inputs: [inputId], protocol: 2 },
  { type: "text-delta", text: "Hello" },
  { type: "run-completed" },
]

const finished = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<any>) =>
  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })

const streaming = (
  registry: AtomRegistry.AtomRegistry,
  chat: { readonly state: Atom.Atom<Thread.Thread> },
) =>
  AtomRegistry.toStream(registry, chat.state).pipe(
    Stream.filter((t) => t.active?.status === "streaming"),
    Stream.runHead,
  )

describe("Atoms.thread", () => {
  it.effect(
    "submit folds the run into the thread and settles it, observed only through state",
    () =>
      Effect.gen(function* () {
        const chat = Atoms.thread({
          runtime,
          busy: "block",
          // Async frames: the run outlives the tick `submit` was called in.
          transport: Transport.local((input: Input.Sent) =>
            Stream.fromIterable(reply(input.id)).pipe(Stream.tap(() => Effect.yieldNow)),
          ),
        })
        const registry = AtomRegistry.make()
        const settled = yield* AtomRegistry.toStream(registry, chat.state).pipe(
          Stream.filter((t) => t.messages.length === 2),
          Stream.runHead,
          Effect.forkChild,
        )
        registry.set(chat.submit, Input.submit("Hi"))
        const thread = yield* Fiber.join(settled).pipe(Effect.map(Option.getOrThrow))

        expect(thread.active).toBeNull()
        const assistant = thread.messages[1]
        expect(assistant?.role === "assistant" && assistant.value.status).toBe("completed")
      }),
  )

  it.effect("stop interrupts a direct run and settles it locally as stopped", () =>
    Effect.gen(function* () {
      const chat = Atoms.thread({
        runtime,
        busy: "block",
        transport: Transport.local((input: Input.Sent) =>
          Stream.fromIterable(reply(input.id).slice(0, 2)).pipe(Stream.concat(Stream.never)),
        ),
      })
      const registry = AtomRegistry.make()
      registry.set(chat.submit, Input.submit("Hi"))
      yield* streaming(registry, chat)
      registry.set(chat.stop, undefined)
      yield* finished(registry, chat.stop)

      const thread = registry.get(chat.state)
      const assistant = thread.messages[1]
      expect(thread.active).toBeNull()
      expect(assistant?.role === "assistant" && assistant.value.status).toBe("stopped")
    }),
  )

  it.effect('busy "block" ignores input while a run is active', () =>
    Effect.gen(function* () {
      const chat = Atoms.thread({
        runtime,
        busy: "block",
        transport: Transport.local((input: Input.Sent) =>
          Stream.fromIterable(reply(input.id).slice(0, 2)).pipe(Stream.concat(Stream.never)),
        ),
      })
      const registry = AtomRegistry.make()
      registry.set(chat.submit, Input.submit("first"))
      yield* streaming(registry, chat)
      registry.set(chat.submit, Input.submit("second"))
      yield* finished(registry, chat.submit)

      const thread = registry.get(chat.state)
      expect(
        thread.messages.flatMap((m) => (m.role === "user" ? [Input.text(m.value)] : [])),
      ).toEqual(["first"])
      expect(thread.active?.status).toBe("streaming")
    }),
  )
})

// An in-memory session server: every run is appended to one replayed stream.
const fakeSession = Effect.gen(function* () {
  const chatId = StreamId.make("chat_1")
  const events = yield* PubSub.unbounded<Envelope>({ replay: 1_000 })
  const last = yield* Ref.make(0)
  const transport = Transport.session({
    send: (_: Option.Option<StreamId>, input: Input.Sent) =>
      Ref.get(last).pipe(
        Effect.flatMap((from) =>
          Stream.fromIterable(reply(input.id)).pipe(
            Run.sequence(chatId, { from }),
            Stream.runForEach((envelope) =>
              PubSub.publish(events, envelope).pipe(Effect.andThen(Ref.set(last, envelope.seq))),
            ),
          ),
        ),
        Effect.as(chatId),
      ),
    events: (_, after) => Stream.fromPubSub(events).pipe(Stream.filter((e) => e.seq > after)),
  })
  return { chatId, transport }
})

const settledCount = (
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Atom<Thread.Thread>,
  count: number,
) =>
  AtomRegistry.toStream(registry, state).pipe(
    Stream.filter((t) => t.active === null && t.messages.length === count),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

describe("Atoms.sessionThread", () => {
  it.effect("runs of one session land in one thread, and a new client re-opens all of them", () =>
    Effect.gen(function* () {
      const { chatId, transport } = yield* fakeSession
      const chat = Atoms.sessionThread({ runtime, transport })
      const registry = AtomRegistry.make()

      registry.set(chat.submit, Input.submit("first"))
      yield* settledCount(registry, chat.state, 2)
      registry.set(chat.submit, Input.submit("second"))
      const thread = yield* settledCount(registry, chat.state, 4)
      expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
      expect(registry.get(chat.streamId)).toBe(chatId)

      // After a reload: the same session, replayed from the start.
      const reloaded = Atoms.sessionThread({ runtime, transport })
      const fresh = AtomRegistry.make()
      fresh.set(reloaded.open, chatId)
      const replayed = yield* settledCount(fresh, reloaded.state, 2)
      expect(replayed.messages.map((m) => m.role)).toEqual(["assistant", "assistant"])
    }),
  )
})
