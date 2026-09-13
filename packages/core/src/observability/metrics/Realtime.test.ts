import { describe, it } from "@effect/vitest"
import { Duration, Effect, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { expect } from "vitest"
import { RealtimeEvent } from "../../domain/Realtime.js"
import * as RealtimeSession from "../../realtime/RealtimeSession.js"
import * as MockRealtimeSession from "../../testing/MockRealtimeSession.js"
import { type MarkRef, mark, markRef } from "./Meter.js"
import { type MetricEvent, isMetricEvent } from "./MetricEvent.js"
import { type TimeToFirstAudio, timeToFirstAudio } from "./Realtime.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const

const request = { model: "gpt-realtime-2.1", inputFormat: pcm, outputFormat: pcm }

/** Every scripted event lands this far after the one before it. */
const STEP = 100

type Meter = <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A | MetricEvent, E, R>

/**
 * Drive a scripted session through a meter, one clock step per event, and
 * report everything that came out. The meter reads the clock per element, so
 * the gaps between scripted events are what it measures. `between` runs after
 * the event at that index, which is where a caller's mark would land.
 */
const run = (
  script: ReadonlyArray<RealtimeEvent>,
  meter: Meter,
  between?: Readonly<Record<number, Effect.Effect<void>>>,
) =>
  Effect.gen(function* () {
    const mock = MockRealtimeSession.layer({ initial: script })
    const seen = yield* Ref.make<ReadonlyArray<RealtimeEvent | MetricEvent>>([])

    yield* Effect.gen(function* () {
      const session = yield* RealtimeSession.open(request)
      yield* Effect.forkChild(
        session.events.pipe(
          Stream.mapEffect((ev) => Effect.as(Effect.sleep(Duration.millis(STEP)), ev)),
          meter,
          Stream.runForEach((ev) => Ref.update(seen, (xs) => [...xs, ev])),
        ),
      )
      yield* Effect.forEach(
        script,
        (_, index) =>
          Effect.andThen(TestClock.adjust(Duration.millis(STEP)), between?.[index] ?? Effect.void),
        { discard: true },
      )
    }).pipe(Effect.scoped, Effect.provide(mock.layer))

    return yield* Ref.get(seen)
  })

const samplesOf = (
  out: ReadonlyArray<RealtimeEvent | MetricEvent>,
): ReadonlyArray<TimeToFirstAudio> =>
  out.filter((ev): ev is TimeToFirstAudio => isMetricEvent(ev) && ev._tag === "TimeToFirstAudio")

const elapsedMs = (samples: ReadonlyArray<TimeToFirstAudio>): ReadonlyArray<number> =>
  samples.map((s) => Duration.toMillis(s.elapsed))

const started = (responseId: string) => RealtimeEvent.ResponseStarted({ responseId })
const audio = (responseId: string) =>
  RealtimeEvent.AudioDelta({ responseId, bytes: new Uint8Array([1, 2]) })
const done = (responseId: string) =>
  RealtimeEvent.ResponseDone({ responseId, reason: "complete" as const })

describe("timeToFirstAudio", () => {
  it.effect("measures SpeechStopped to the first AudioDelta, once per response", () =>
    Effect.gen(function* () {
      const out = yield* run(
        [
          RealtimeEvent.SpeechStarted(),
          RealtimeEvent.SpeechStopped(),
          started("r1"),
          audio("r1"),
          audio("r1"),
          done("r1"),
        ],
        timeToFirstAudio(),
      )
      const samples = samplesOf(out)

      expect(samples).toHaveLength(1)
      // Two steps: SpeechStopped, then ResponseStarted, then the audio.
      expect(elapsedMs(samples)).toEqual([STEP * 2])
      expect(samples[0]?.anchor).toBe("speech-stop")
      expect(samples[0]?.turnIndex).toBe(0)
      // The exporter reads only this, and the anchor has to ride along.
      expect(samples[0]?.measurements).toEqual([
        {
          name: "effect_uai_response_time_to_first_audio",
          kind: "timer",
          value: Duration.millis(STEP * 2),
          attributes: { anchor: "speech-stop" },
        },
      ])
      // The session's own events still reach the caller; a meter only adds.
      expect(out.filter((ev) => !isMetricEvent(ev))).toHaveLength(6)
    }),
  )

  it.effect("measures each response from its own SpeechStopped", () =>
    Effect.gen(function* () {
      const out = yield* run(
        [
          RealtimeEvent.SpeechStopped(),
          audio("r1"),
          done("r1"),
          RealtimeEvent.SpeechStopped(),
          RealtimeEvent.OutputTranscriptDelta({ responseId: "r2", text: "one moment" }),
          audio("r2"),
          done("r2"),
        ],
        timeToFirstAudio(),
      )
      const samples = samplesOf(out)

      expect(samples.map((s) => s.turnIndex)).toEqual([0, 1])
      // The second response waited a step longer, measured from its own
      // SpeechStopped rather than from the first response's.
      expect(elapsedMs(samples)).toEqual([STEP, STEP * 2])
    }),
  )

  it.effect("reports nothing for a response that never saw its anchor", () =>
    Effect.gen(function* () {
      // What Gemini emits: audio arrives with no SpeechStopped before it.
      const out = yield* run([started("r1"), audio("r1"), done("r1")], timeToFirstAudio())

      expect(samplesOf(out)).toHaveLength(0)
      // The events themselves are untouched, so the silence is the missing
      // anchor and not a meter that swallowed the stream.
      expect(out).toHaveLength(3)
    }),
  )

  it.effect("keeps counting responses that produced no audio at all", () =>
    Effect.gen(function* () {
      const out = yield* run(
        [
          // A response that only calls a tool speaks nothing and still ends.
          RealtimeEvent.SpeechStopped(),
          started("r1"),
          RealtimeEvent.ToolCall({
            responseId: "r1",
            call: {
              type: "function_call",
              call_id: "call_1",
              name: "get_weather",
              arguments: "{}",
              providerData: undefined,
            },
          }),
          done("r1"),
          RealtimeEvent.SpeechStopped(),
          audio("r2"),
          done("r2"),
        ],
        timeToFirstAudio(),
      )
      const samples = samplesOf(out)

      expect(samples).toHaveLength(1)
      // The silent response still spent a segment, and its anchor never leaked
      // into the one that answered.
      expect(samples[0]?.turnIndex).toBe(1)
      expect(elapsedMs(samples)).toEqual([STEP])
    }),
  )

  it.effect("measures from a caller's mark, on a stream with no anchor event", () =>
    Effect.gen(function* () {
      const ref: MarkRef = yield* markRef
      // Gemini's shape: no SpeechStopped anywhere, the caller stamps instead.
      const out = yield* run(
        [started("r1"), audio("r1"), done("r1")],
        timeToFirstAudio({ from: ref }),
        // Stamped right after the session opened, one step before the audio.
        { 0: mark(ref) },
      )
      const samples = samplesOf(out)

      expect(samples).toHaveLength(1)
      expect(elapsedMs(samples)).toEqual([STEP])
      expect(samples[0]?.anchor).toBe("mark")
      expect(samples[0]?.measurements[0]?.attributes).toEqual({ anchor: "mark" })
    }),
  )

  it.effect("spends a mark once, so the next response waits for a fresh one", () =>
    Effect.gen(function* () {
      const ref: MarkRef = yield* markRef
      const out = yield* run(
        [started("r1"), audio("r1"), done("r1"), started("r2"), audio("r2"), done("r2")],
        timeToFirstAudio({ from: ref }),
        { 0: mark(ref) },
      )
      const samples = samplesOf(out)

      // The second response has no mark of its own, and the first one's is
      // spent, so it reports nothing rather than a number counted from a
      // timestamp that belongs to the turn before it.
      expect(samples).toHaveLength(1)
      expect(samples[0]?.turnIndex).toBe(0)
    }),
  )

  it.effect("measures the second response once a fresh mark arrives", () =>
    Effect.gen(function* () {
      const ref: MarkRef = yield* markRef
      const out = yield* run(
        [started("r1"), audio("r1"), done("r1"), started("r2"), audio("r2"), done("r2")],
        timeToFirstAudio({ from: ref }),
        { 0: mark(ref), 2: mark(ref) },
      )
      const samples = samplesOf(out)

      expect(samples.map((s) => s.turnIndex)).toEqual([0, 1])
      expect(elapsedMs(samples)).toEqual([STEP, STEP * 2])
    }),
  )
})
