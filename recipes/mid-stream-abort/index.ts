/**
 * Cancel an in-flight `streamTurn` cleanly via `Stream.interruptWhen`.
 * When the abort `Deferred` completes, the conversation stream ends, the
 * loop's outer scope closes, and Effect's structured concurrency tears
 * down the HTTP response - which signals `AbortController` on the
 * underlying `fetch`, closing the upstream connection.
 *
 * The recipe asks for a long answer, then triggers abort after 1 second.
 * Watch the partial text deltas arrive in the log before the stream
 * stops; no `turn_complete` is emitted because the turn never finished.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/mid-stream-abort/index.ts`
 */
import {
  Config,
  Deferred,
  Effect,
  Layer,
  Logger,
  Match,
  References,
  Stream,
  pipe,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@betalyra/effect-uai-core/Items"
import { loop, stop, streamUntilComplete } from "@betalyra/effect-uai-core/Loop"
import { matchType } from "@betalyra/effect-uai-core/Match"
import * as Turn from "@betalyra/effect-uai-core/Turn"
import { Responses, layer as responsesLayer } from "@betalyra/effect-uai-responses"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>
}

const initial: State = {
  history: [
    Items.userText(
      "Write a long, detailed essay (around 500 words) about the history of the Portuguese azulejo tile.",
    ),
  ],
}

// ---------------------------------------------------------------------------
// The loop - a single turn that runs to completion, unless interrupted.
// ---------------------------------------------------------------------------

const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      // No `reasoning` so output tokens start streaming immediately;
      // with `reasoning.effort` the model thinks before emitting text and
      // a short abort window can land before any delta arrives.
      return oai
        .streamTurn(state.history, {})
        .pipe(streamUntilComplete(() => Effect.sync(() => stop)))
    }),
  ),
)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const ABORT_AFTER = "3 seconds"

const program = Effect.gen(function* () {
  const abort = yield* Deferred.make<void>()

  // External trigger - in a real app this is a UI button / signal handler.
  yield* Effect.forkChild(
    Effect.gen(function* () {
      yield* Effect.sleep(ABORT_AFTER)
      yield* Effect.logInfo(`abort fired after ${ABORT_AFTER}`)
      yield* Deferred.succeed(abort, undefined)
    }),
  )

  yield* Stream.runForEach(
    conversation.pipe(Stream.interruptWhen(Deferred.await(abort))),
    (event) =>
      Match.value(event).pipe(
        matchType("text_delta", ({ text }) => Effect.logInfo("delta", { text })),
        matchType("turn_complete", ({ turn }) =>
          Effect.logInfo("turn complete (not expected if abort fires first)", {
            stop_reason: turn.stop_reason,
            assistant: Turn.assistantMessages(turn)
              .flatMap((m) => m.content)
              .filter(Items.isOutputText)
              .map((c) => c.text)
              .join(" "),
          }),
        ),
        Match.orElse(() => Effect.void),
      ),
  )

  yield* Effect.logInfo("loop ended")
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

const runtime = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(Effect.provide(runtime), Effect.provideService(References.MinimumLogLevel, "Info")),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
