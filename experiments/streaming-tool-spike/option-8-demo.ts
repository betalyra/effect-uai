/**
 * Live demo: prints ToolEvents from `executeAllSafe` as they arrive,
 * with a wall-clock timestamp so you can see real-time vs buffered.
 *
 * Run:
 *   pnpm tsx experiments/streaming-tool-spike/option-8-demo.ts
 */
import { Effect, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import { executeAllSafe, isIntermediate, isOutput, streaming } from "./option-8-always-stream.js"

// Two slow streaming tools running in parallel. Each emits 3 events with
// a 300ms gap between them; they should interleave in real-time.

const SlowInput = Schema.Struct({ name: Schema.String, delayMs: Schema.Number })

const slowTool = streaming({
  name: "slow",
  description: "emits 3 thoughts with a delay between them",
  inputSchema: Tool.fromEffectSchema(SlowInput),
  run: ({ name, delayMs }) =>
    Stream.unfold(0, (i: number) =>
      i >= 3
        ? Effect.succeed(undefined)
        : Effect.delay(
            Effect.succeed([{ tool: name, step: i }, i + 1] as const),
            `${delayMs} millis`,
          ),
    ),
  finalize: (events) => ({ steps: events.length }),
  strict: true,
})

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const start = Date.now()
const ts = () => `+${(Date.now() - start).toString().padStart(4, " ")}ms`

const program = executeAllSafe(
  [slowTool],
  [
    fc("c1", "slow", { name: "alpha", delayMs: 300 }),
    fc("c2", "slow", { name: "beta", delayMs: 250 }),
  ],
).pipe(
  Stream.tap((event) =>
    Effect.sync(() => {
      if (isIntermediate(event)) {
        console.log(`${ts()}  intermediate  ${event.call_id}  ${JSON.stringify(event.data)}`)
      } else if (isOutput(event)) {
        console.log(`${ts()}  OUTPUT        ${event.output.call_id}  ${event.output.output}`)
      }
    }),
  ),
  Stream.runDrain,
)

console.log(`${ts()}  starting...`)
await Effect.runPromise(program)
console.log(`${ts()}  done.`)
