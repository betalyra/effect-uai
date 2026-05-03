/**
 * Option 8 - real-time `executeAllSafe` returning `Stream<ToolEvent>`.
 *
 * Each call's events flow through to the consumer **as they happen** (not
 * buffered until all tools finish). Per-call shape:
 *
 *   - non-streaming tool: emits one `Output` event when its `Effect` resolves.
 *   - streaming tool: each element from the tool's `Stream<Event>` becomes
 *     one `Intermediate` event; when the stream ends, one synthetic `Output`
 *     event is appended carrying `finalize(events)`.
 *
 * The Ref+concat pattern is the trick that gets us real-time: a `Stream.tap`
 * appends each event into a `Ref` while it flows through, and a final
 * `Stream.fromEffect` reads the Ref and emits the Output. No `runCollect`,
 * no buffering.
 *
 * `executeAllSafe` itself merges per-call streams concurrently via
 * `Stream.flatMap({ concurrency: "unbounded" })`. Calls are independent.
 *
 * Recipe shape: `executeAllSafe` returns `Stream<ToolEvent>` directly. To
 * thread outputs into next-state, recipes use `nextStateFrom(stream, build)`
 * which encapsulates the output-collection Ref. Recipe author never sees a
 * Ref.
 */
import { Array as Arr, Effect, Ref, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Loop from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"

// ---------------------------------------------------------------------------
// ToolEvent - what the executor's stream emits.
// ---------------------------------------------------------------------------

export type ToolEvent =
  | {
      readonly _tag: "Intermediate"
      readonly call_id: string
      readonly tool: string
      readonly data: unknown
    }
  | { readonly _tag: "Output"; readonly output: Items.FunctionCallOutput }

export const isIntermediate = (
  e: ToolEvent,
): e is Extract<ToolEvent, { _tag: "Intermediate" }> => e._tag === "Intermediate"
export const isOutput = (e: ToolEvent): e is Extract<ToolEvent, { _tag: "Output" }> =>
  e._tag === "Output"

// ---------------------------------------------------------------------------
// StreamingTool - `run` returns `Stream<Event>`, `finalize` reduces the
// collected events into the model-facing `Output`.
// ---------------------------------------------------------------------------

export interface StreamingTool<Name extends string, Input, Event, Output, R = never> {
  readonly _kind: "streaming"
  readonly name: Name
  readonly description: string
  readonly inputSchema: Tool.ToolInputSchema<Input>
  readonly run: (input: Input) => Stream.Stream<Event, unknown, R>
  readonly finalize: (events: ReadonlyArray<Event>) => Output
  readonly strict?: boolean
}

export const streaming = <Name extends string, Input, Event, Output, R = never>(
  spec: Omit<StreamingTool<Name, Input, Event, Output, R>, "_kind">,
): StreamingTool<Name, Input, Event, Output, R> => ({ _kind: "streaming", ...spec })

type AnyStreamingTool = StreamingTool<string, any, any, any, never>
type AnyPlainTool = Tool.Tool<string, any, any, never>
export type AnyKindTool = AnyStreamingTool | AnyPlainTool

const isStreamingTool = (t: AnyKindTool): t is AnyStreamingTool =>
  "_kind" in t && t._kind === "streaming"

// ---------------------------------------------------------------------------
// `executeAllSafe` - real-time Stream<ToolEvent>. Calls run concurrently;
// each call's events flow through as they're produced.
// ---------------------------------------------------------------------------

export const executeAllSafe = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<Items.FunctionCall>,
): Stream.Stream<ToolEvent> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(tools, call), { concurrency: "unbounded" }),
  )

const runOne = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> => {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    return Stream.fromEffect(Effect.die(`Unknown tool: ${call.name}`))
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return Stream.fromEffect(
    Tool.execute(tool, call).pipe(
      Effect.catchTag("ToolError", (err) => Effect.succeed(Toolkit.defaultRepair(err, call))),
      Effect.map((output) => ({ _tag: "Output", output }) satisfies ToolEvent),
    ),
  )
}

const failedOutput = (
  call: Items.FunctionCall,
  toolName: string,
  message: string,
): ToolEvent => ({
  _tag: "Output",
  output: Items.functionCallOutput(
    call.call_id,
    JSON.stringify({ kind: "execution_error", tool: toolName, message }),
  ),
})

const runStreaming = (
  tool: AnyStreamingTool,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.arguments),
        catch: () => "json_parse_error" as const,
      })
      const validated = yield* Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: () => "validation_threw" as const,
      })
      if (validated.issues !== undefined) {
        return Stream.succeed(
          failedOutput(call, tool.name, "Tool input failed schema validation"),
        )
      }

      // Real-time: tap each event into a Ref as it flows; emit one
      // Intermediate per event; then concat one synthetic Output element
      // built from the accumulated Ref via `finalize`.
      const ref = yield* Ref.make<ReadonlyArray<unknown>>([])
      const intermediates = tool.run(validated.value).pipe(
        Stream.tap((event) => Ref.update(ref, Arr.append(event))),
        Stream.map(
          (data) =>
            ({
              _tag: "Intermediate",
              call_id: call.call_id,
              tool: tool.name,
              data,
            }) satisfies ToolEvent,
        ),
      )
      const output = Stream.fromEffect(
        Ref.get(ref).pipe(
          Effect.map(
            (events) =>
              ({
                _tag: "Output",
                output: Items.functionCallOutput(
                  call.call_id,
                  JSON.stringify(tool.finalize(events as ReadonlyArray<any>)),
                ),
              }) satisfies ToolEvent,
          ),
        ),
      )
      return intermediates.pipe(Stream.concat(output))
    }),
  ).pipe(
    Stream.catchCause(() =>
      Stream.succeed(failedOutput(call, tool.name, "Tool execution failed")),
    ),
  )

// ---------------------------------------------------------------------------
// `nextAfterFold` - general primitive. Drain a stream to the consumer in
// real-time as `Loop.value(a)`, fold elements into an accumulator via
// `reduce`, and at end-of-stream emit one `Loop.next(build(finalAcc))`.
//
// Subsumes `Loop.nextAfter` (state is constant: pass `(s, _) => s` and
// `(s) => s`) and `nextStateFrom` (collect Output events into an array,
// build state from that array).
// ---------------------------------------------------------------------------

export const nextAfterFold = <A, B, S, E, R>(
  stream: Stream.Stream<A, E, R>,
  initial: B,
  reduce: (acc: B, a: A) => B,
  build: (b: B) => S,
): Stream.Stream<Loop.Event<A, S>, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      const tapped = stream.pipe(
        Stream.tap((a) => Ref.update(ref, (acc) => reduce(acc, a))),
        Stream.map(Loop.value),
      )
      const continuation = Stream.fromEffect(
        Ref.get(ref).pipe(Effect.map((acc) => Loop.next(build(acc)))),
      )
      return tapped.pipe(Stream.concat(continuation))
    }),
  )

// ---------------------------------------------------------------------------
// `nextStateFrom` - specialization of `nextAfterFold` for the streaming-
// tool case. Collects every `Output` event's `FunctionCallOutput` into an
// array, then hands it to `build` for state construction. Recipes never
// see the Ref or the fold primitive.
// ---------------------------------------------------------------------------

export const nextStateFrom = <S>(
  stream: Stream.Stream<ToolEvent>,
  build: (outputs: ReadonlyArray<Items.FunctionCallOutput>) => S,
): Stream.Stream<Loop.Event<ToolEvent, S>> =>
  nextAfterFold(
    stream,
    [] as ReadonlyArray<Items.FunctionCallOutput>,
    (acc, e) => (isOutput(e) ? Arr.append(acc, e.output) : acc),
    build,
  )

// ---------------------------------------------------------------------------
// Toy tools demonstrating the three patterns `finalize` handles.
// ---------------------------------------------------------------------------

// --- Pattern 1: aggregate by concatenation (sub-agent text accumulation) ---

interface ThoughtEvent {
  readonly thought: string
}

export interface ThinkerOutput {
  readonly answer: string
  readonly thoughts: ReadonlyArray<string>
}

const ThinkerInput = Schema.Struct({ question: Schema.String })

export const thinker = streaming({
  name: "thinker",
  description: "Think step by step.",
  inputSchema: Tool.fromEffectSchema(ThinkerInput),
  run: ({ question }) =>
    Stream.fromIterable<ThoughtEvent>([
      { thought: `considering ${question}...` },
      { thought: "almost there..." },
      { thought: "finalizing..." },
    ]),
  finalize: (events): ThinkerOutput => ({
    thoughts: events.map((e) => e.thought),
    answer: `Final reasoning step: ${events[events.length - 1]?.thought ?? "n/a"}`,
  }),
  strict: true,
})

// --- Pattern 2: collect a list (recipe streamer) -----------------------

export interface Recipe {
  readonly title: string
  readonly time_minutes: number
}

export interface RecipeListOutput {
  readonly recipes: ReadonlyArray<Recipe>
}

const RecipeStreamerInput = Schema.Struct({ cuisine: Schema.String })

export const recipeStreamer = streaming({
  name: "recipe_streamer",
  description: "Stream a list of recipes for a cuisine.",
  inputSchema: Tool.fromEffectSchema(RecipeStreamerInput),
  run: ({ cuisine }) =>
    Stream.fromIterable<Recipe>([
      { title: `${cuisine} starter`, time_minutes: 10 },
      { title: `${cuisine} main`, time_minutes: 35 },
      { title: `${cuisine} dessert`, time_minutes: 20 },
    ]),
  finalize: (recipes): RecipeListOutput => ({ recipes }),
  strict: true,
})

// --- Pattern 3: progress + final result (slow download) ----------------

export type DownloadEvent =
  | { readonly type: "progress"; readonly pct: number }
  | { readonly type: "result"; readonly bytes: string }

export interface DownloadOutput {
  readonly status: "completed" | "failed"
  readonly bytes: string
}

const SlowDownloadInput = Schema.Struct({ url: Schema.String })

export const slowDownload = streaming({
  name: "slow_download",
  description: "Download a file, emitting progress events along the way.",
  inputSchema: Tool.fromEffectSchema(SlowDownloadInput),
  run: ({ url }) =>
    Stream.fromIterable<DownloadEvent>([
      { type: "progress", pct: 0 },
      { type: "progress", pct: 50 },
      { type: "progress", pct: 100 },
      { type: "result", bytes: `bytes-of-${url}` },
    ]),
  finalize: (events): DownloadOutput => {
    const result = events.find((e) => e.type === "result")
    return result
      ? { status: "completed", bytes: result.bytes }
      : { status: "failed", bytes: "" }
  },
  strict: true,
})

// --- Non-streaming control ---------------------------------------------

const EchoInput = Schema.Struct({ text: Schema.String })

export const echo = Tool.make({
  name: "echo",
  description: "Echo the input.",
  inputSchema: Tool.fromEffectSchema(EchoInput),
  run: ({ text }) => Effect.succeed({ echoed: text }),
  strict: true,
})
