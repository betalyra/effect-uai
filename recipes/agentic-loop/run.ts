/**
 * Interactive CLI runner. Reads lines from stdin, sends them to the
 * conversation queue, prints model output as it streams. Ctrl-C exits.
 *
 * The agent has two simple tools:
 *   - get_current_time(timezone)  - real, via Effect's DateTime
 *   - roll_dice(sides)            - fake, returns a uniform roll
 *
 * Try sending a few quick messages in a row - they'll be coalesced
 * into one user batch by the 200ms settle window, the model will run
 * a turn (possibly with a tool), reply, and the prompt will return
 * for the next message. While the model is responding to your batch,
 * you can already type the next message; it'll be picked up after the
 * current turn finishes.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/agentic-loop/run.ts`
 */
import * as readline from "node:readline"
import { Config, DateTime, Effect, Layer, Match, Option, Queue, Ref, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Tool from "@effect-uai/core/Tool"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { conversation } from "./index.js"

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const InvalidTimeZone = (timezone: string) => new Error(`Invalid IANA timezone: ${timezone}`)

// `Effect.delay` simulates a bit of real-world latency so the runner
// reads like an actual agent doing work between turns.
const getCurrentTime = Tool.make({
  name: "get_current_time",
  description:
    "Look up the current local time for an IANA timezone, e.g. 'Europe/Lisbon' or 'Asia/Tokyo'.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ timezone: Schema.String })),
  run: ({ timezone }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        DateTime.setZoneNamed(now, timezone).pipe(
          Option.match({
            onNone: () => Effect.fail(InvalidTimeZone(timezone)),
            onSome: (zoned) => Effect.succeed({ timezone, iso: DateTime.formatIsoZoned(zoned) }),
          }),
        ),
      ),
      Effect.delay("400 millis"),
    ),
  strict: true,
})

const rollDice = Tool.make({
  name: "roll_dice",
  description: "Roll a fair die with the given number of sides (e.g. 6 or 20).",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ sides: Schema.Number })),
  run: ({ sides }) =>
    Effect.sync(() => ({ sides, roll: Math.floor(Math.random() * sides) + 1 })).pipe(
      Effect.delay("600 millis"),
    ),
  strict: true,
})

const tools: ReadonlyArray<Tool.AnyKindTool> = [getCurrentTime, rollDice]

// ---------------------------------------------------------------------------
// stdin -> queue. `Effect.async` registers the readline listener and
// returns a finalizer that closes the interface on interruption.
// ---------------------------------------------------------------------------

// Read a line from stdin synchronously inside the readline callback.
// The runner gives us a `streaming` Ref so the prompt-side handler
// can peek "is the model currently streaming a turn?" at the moment
// a line lands - mid-turn arrivals get a different decoration than
// burst-batched ones.
const readStdinInto = (
  queue: Queue.Queue<string>,
  streaming: Ref.Ref<boolean>,
): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return

      // Peek state at the moment the line lands.
      const isStreaming = Ref.getUnsafe(streaming)
      const pending = Queue.sizeUnsafe(queue)
      Queue.offerUnsafe(queue, trimmed)

      if (isStreaming) {
        process.stdout.write(`  ↳ buffered (model is busy, will pick up next turn)\n`)
      } else if (pending > 0) {
        process.stdout.write(`  ↳ batched (${pending + 1} messages waiting in burst)\n`)
      }
    })
    rl.on("close", () => resume(Effect.interrupt))
    return Effect.sync(() => rl.close())
  })

// ---------------------------------------------------------------------------
// Render the conversation stream as a chat transcript on stdout.
// ---------------------------------------------------------------------------

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const renderConversation = (queue: Queue.Queue<string>, streaming: Ref.Ref<boolean>) =>
  // The renderer flips `streaming` true on the first event of each
  // turn and back to false on `TurnComplete`, so the stdin handler
  // knows whether incoming lines are landing mid-turn.
  Stream.runForEach(conversation(queue, tools, "1500 millis"), (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        Output: ({ result }) =>
          result._tag === "Value"
            ? write(`\n  [${result.tool} → ${JSON.stringify(result.value)}]\n`)
            : Effect.void,
        TextDelta: ({ text }) => Ref.set(streaming, true).pipe(Effect.andThen(write(text))),
        ToolCallStart: ({ name }) =>
          Ref.set(streaming, true).pipe(Effect.andThen(write(`\n  [calling ${name}…]`))),
        TurnComplete: () => Ref.set(streaming, false).pipe(Effect.andThen(write("\n\nyou> "))),
      }),
      Match.orElse(() => Effect.void),
    ),
  )

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  yield* write(
    "agentic-loop chat. Try a quick burst of messages or ask for the time.\n" +
      "Ctrl-C to exit.\n\nyou> ",
  )

  const queue = yield* Queue.unbounded<string>()
  const streaming = yield* Ref.make(false)

  // Read stdin in the background; foreground runs the conversation
  // renderer. Both end when the fiber is interrupted (Ctrl-C / EOF).
  yield* Effect.forkChild(readStdinInto(queue, streaming))
  yield* renderConversation(queue, streaming)
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(program.pipe(Effect.provide(mainLayer))).catch((err) => {
  console.error("\nrecipe failed:", err)
  process.exit(1)
})
