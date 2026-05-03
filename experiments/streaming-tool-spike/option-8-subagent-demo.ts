/**
 * Live demo: sub-agent recipe with timestamps. Watch inner-agent text
 * deltas flow through to the consumer as ToolEvent.Intermediate, then a
 * single Output carrying the accumulated answer.
 *
 * Run:
 *   pnpm tsx experiments/streaming-tool-spike/option-8-subagent-demo.ts
 */
import { Effect, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import { isIntermediate, isOutput, type ToolEvent } from "./option-8-always-stream.js"
import { buildConversation } from "./option-8-subagent.js"

const start = Date.now()
const ts = () => `+${(Date.now() - start).toString().padStart(4, " ")}ms`

// Mocked inner agent: 4 text deltas with 200ms gaps, then turn_complete.
// Real-time: each delta should arrive at its own 200ms tick, not buffered.
const innerAgent = (question: string): Stream.Stream<Turn.TurnEvent> => {
  const fragments = [
    `Hmm, "${question}"... `,
    "let me reason... ",
    "considering options... ",
    "the answer is 42.",
  ]
  return Stream.fromIterable(fragments).pipe(
    Stream.mapEffect((text) =>
      Effect.delay(
        Effect.succeed({ type: "text_delta", text } as Turn.TurnEvent),
        "200 millis",
      ),
    ),
    Stream.concat(
      Stream.succeed<Turn.TurnEvent>({
        type: "turn_complete",
        turn: {
          stop_reason: "stop",
          usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
          items: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: fragments.join("") }],
            },
          ],
        },
      }),
    ),
  )
}

// Outer loop script: turn 1 calls ask_subagent; turn 2 final answer.
const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const outerScript: ReadonlyArray<Turn.Turn> = [
  {
    stop_reason: "tool_calls",
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    items: [fc("c1", "ask_subagent", { question: "What is the meaning of life?" })],
  },
  {
    stop_reason: "stop",
    usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The sub-agent reasoned through it and concluded: 42.",
          },
        ],
      },
    ],
  },
]

const initial = {
  history: [
    Items.userText("Find out the meaning of life by asking a sub-agent."),
  ] as ReadonlyArray<Items.Item>,
}

const conversation = buildConversation(initial, innerAgent)

const printEvent = (event: Turn.TurnEvent | ToolEvent) => {
  if ("type" in event) {
    if (event.type === "text_delta") {
      console.log(`${ts()}  outer.text_delta    ${JSON.stringify(event.text)}`)
    } else if (event.type === "turn_complete") {
      console.log(
        `${ts()}  outer.turn_complete ${event.turn.stop_reason}`,
      )
    }
  } else if (isIntermediate(event)) {
    const data = event.data as Turn.TurnEvent
    const summary =
      data.type === "text_delta"
        ? `text_delta ${JSON.stringify(data.text)}`
        : data.type === "turn_complete"
          ? `turn_complete ${data.turn.stop_reason}`
          : data.type
    console.log(`${ts()}  inner.${summary}`)
  } else if (isOutput(event)) {
    console.log(`${ts()}  TOOL OUTPUT         ${event.output.output}`)
  }
}

const program = conversation.pipe(
  Stream.tap((event) => Effect.sync(() => printEvent(event as Turn.TurnEvent | ToolEvent))),
  Stream.runDrain,
)

console.log(`${ts()}  starting...`)
await Effect.runPromise(program.pipe(Effect.provide(MockProvider.layer(outerScript))))
console.log(`${ts()}  done.`)
