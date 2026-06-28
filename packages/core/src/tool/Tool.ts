import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import type { ToolCall, ToolCallOutput } from "../domain/Items.js"
import { toolCallOutput } from "../domain/Items.js"

export class ToolError extends Schema.TaggedErrorClass<ToolError>("@betalyra/effect-uai/ToolError")(
  "ToolError",
  {
    call_id: Schema.String,
    tool: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * One Standard Schema validation issue, carried on `ToolValidationError`.
 * Mirrors `StandardSchemaV1.Issue`; `path` is left as `unknown` elements
 * because Standard Schema path segments may be symbols or `{ key }` objects.
 */
const ToolValidationIssue = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.Unknown)),
})

/**
 * The model's `arguments` for a call failed the tool's `inputSchema`. Distinct
 * from `ToolError` (malformed JSON, runtime crash) so callers can tell a
 * contract violation apart from a parse or execution failure, and so the
 * structured `issues` survive instead of being flattened into a message string.
 */
export class ToolValidationError extends Schema.TaggedErrorClass<ToolValidationError>(
  "@betalyra/effect-uai/ToolValidationError",
)("ToolValidationError", {
  call_id: Schema.String,
  tool: Schema.String,
  issues: Schema.Array(ToolValidationIssue),
}) {}

/**
 * Schemas accepted on `Tool.inputSchema`. Must implement both Standard
 * Schema validation and JSON Schema conversion (for rendering tool
 * descriptors to provider request bodies).
 *
 * Any Standard-Schema-compliant library that exposes both interfaces
 * works directly: Zod 4+, Valibot, ArkType, Effect Schema (after
 * `fromEffectSchema`), etc.
 */
export type ToolInputSchema<Input = unknown> = StandardSchemaV1<unknown, Input> &
  StandardJSONSchemaV1<unknown, Input>

/**
 * Convenience wrapper for Effect Schema users - adds both the
 * `validate` and `jsonSchema` extensions to a plain Effect Schema so it
 * can be used as a `Tool.inputSchema`.
 */
export const fromEffectSchema = <S extends Schema.Codec<any, any, never, any>>(
  schema: S,
): S & ToolInputSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

/**
 * Use any schema library that implements both Standard Schema (validation)
 * and Standard JSON Schema (JSON Schema generation) as a `Tool.inputSchema`.
 * Covers Zod 4.2+, Valibot 1.2+, and ArkType 2.1.28+ in one helper.
 *
 * Effect Schema doesn't implement Standard JSON Schema natively — use
 * `fromEffectSchema` for those.
 *
 * The intersection constraint catches missing interfaces at compile time:
 * a Zod v3 schema (no Standard JSON Schema) produces a precise type error
 * pointing at the missing interface rather than a runtime surprise. The
 * helper itself is a thin type-narrowing identity — schemas that satisfy
 * both standards already structurally satisfy `ToolInputSchema`; the
 * helper makes the input type inference explicit at the call site.
 */
export const fromStandardSchema = <S extends StandardSchemaV1 & StandardJSONSchemaV1>(
  schema: S,
): S & ToolInputSchema<StandardSchemaV1.InferOutput<S>> =>
  schema as S & ToolInputSchema<StandardSchemaV1.InferOutput<S>>

/**
 * Emit one intermediate `Event` from inside a tool's `run`. Backed by the
 * executor's per-call queue, so it returns an `Effect` (backpressure) and
 * composes with `Stream.runForEach(emit)`.
 */
export type Emit<Event> = (event: Event) => Effect.Effect<void>

/**
 * A model-visible tool with a local `Effect` executor. `run` computes the
 * model-facing `Output`; emitting progress is a side channel via `emit`. A
 * plain tool never calls `emit` (its `Event` is irrelevant); a streaming tool
 * emits intermediate `Event`s that flow to the consumer as
 * `ToolEvent.Progress` in real time.
 *
 * This is one of four tool *kinds*, discriminated by `_tag`. The other three
 * (`ProviderTool`, `SignalTool`, `InteractionTool`) are model-visible but have
 * no local executor — see their constructors below. `Tool` keeps its name (and
 * the `Tool.make` constructor) because the local kind is by far the common one.
 */
export type Tool<Name extends string, Input, Event, Output, R = never> = {
  readonly _tag: "LocalTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output, unknown, R>
  /**
   * Bound on this tool's emit queue. Unbounded when omitted. Per-tool because
   * backpressure depends on how a given tool emits, unlike `concurrency`
   * (cross-tool, on `Toolkit.run`'s options).
   */
  readonly emitBufferSize?: number
  /**
   * Whether the provider should render this tool with its strict-mode
   * flag (OpenAI's `strict: true`, etc). Default: true. The framework
   * never rewrites the schema; if the rendered JSON Schema isn't
   * compatible, the provider returns an error.
   */
  readonly strict?: boolean
}

/**
 * A provider-hosted tool: visible to the model and executed by the *provider*
 * (native web search, code execution, RAG grounding), never by this process.
 * It has no local `run`; `provider`/`config` tell the provider adapter how to
 * render it. Passing it to `Toolkit.run` yields a `non_local_tool` result.
 */
export type ProviderTool<Name extends string, Input, Provider extends string, Config> = {
  readonly _tag: "ProviderTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly provider: Provider
  readonly config: Config
  readonly strict?: boolean
}

/**
 * A typed request for the agent loop to change control flow (escalate, pause,
 * schedule, hand off). Model-visible and decodable (`decodeArgs`) but never
 * locally executed — the loop intercepts the call in `onTurnComplete` and acts
 * on it, so there is no fake `run`. `Toolkit.run` reports it as `non_local_tool`.
 */
export type SignalTool<Name extends string, Input> = {
  readonly _tag: "SignalTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
}

/**
 * A typed request for an external actor (user, channel, frontend) to respond
 * before the loop resumes. Like `SignalTool` it is decode-only, but its
 * lifecycle differs: the loop usually stops/pauses and resumes later by
 * appending a `function_call_output` once the actor replies.
 */
export type InteractionTool<Name extends string, Input> = {
  readonly _tag: "InteractionTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
}

/** A local (executable) tool of any shape. Readability alias. */
export type AnyLocalTool<R = any> = Tool<string, any, any, any, R>

/** Any of the four model-visible tool kinds. */
export type AnyTool<R = any> =
  | Tool<string, any, any, any, R>
  | ProviderTool<string, any, string, any>
  | SignalTool<string, any>
  | InteractionTool<string, any>

/** A model-visible tool that carries a decodable input schema (every kind). */
export type DecodableTool<Input> = {
  readonly name: string
  readonly inputSchema: ToolInputSchema<Input>
}

/** Extract the `R` of a local tool; non-local kinds contribute `never`. */
export type ToolR<T> = T extends Tool<string, any, any, any, infer R> ? R : never

/**
 * Provider-agnostic tool descriptor. Each provider maps `inputSchema`
 * to its own wire field (OpenAI → `parameters`, Anthropic →
 * `input_schema`). Built from a `Tool` by `Tool.toDescriptors`.
 */
export type ToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly strict?: boolean
}

/** A model-visible tool with a local `Effect` executor. */
export const make = <Name extends string, Input, Event, Output, R = never>(
  spec: Omit<Tool<Name, Input, Event, Output, R>, "_tag">,
): Tool<Name, Input, Event, Output, R> => ({ _tag: "LocalTool", ...spec })

/**
 * A provider-hosted tool (native web search, code execution, RAG grounding).
 * No local executor — `provider`/`config` drive the provider adapter's
 * rendering. The model sees it; `Toolkit.run` reports it as `non_local_tool`.
 */
export const provider = <Name extends string, Input, Provider extends string, Config>(
  spec: Omit<ProviderTool<Name, Input, Provider, Config>, "_tag">,
): ProviderTool<Name, Input, Provider, Config> => ({ _tag: "ProviderTool", ...spec })

/**
 * A typed control-flow signal to the agent loop (escalate, pause, schedule,
 * hand off). Decode-only: the loop interprets the call rather than executing a
 * handler, so there is no `run`.
 */
export const signal = <Name extends string, Input>(
  spec: Omit<SignalTool<Name, Input>, "_tag">,
): SignalTool<Name, Input> => ({ _tag: "SignalTool", ...spec })

/**
 * A typed request for an external actor to respond before the loop resumes
 * (frontend, Telegram, CLI prompt). Decode-only; the loop stops/pauses and
 * resumes by appending the actor's `function_call_output`.
 */
export const interaction = <Name extends string, Input>(
  spec: Omit<InteractionTool<Name, Input>, "_tag">,
): InteractionTool<Name, Input> => ({ _tag: "InteractionTool", ...spec })

/**
 * Return a copy of a tool under a new `name`. Useful for resolving a name
 * clash before combining tools into one `Toolkit`. Literal-preserving, so the
 * renamed tool keys the toolkit record under the new name statically.
 */
export const withName = <N extends string, T extends AnyTool>(
  tool: T,
  name: N,
): Omit<T, "name"> & { readonly name: N } => ({ ...tool, name })

/**
 * Replace a local tool's `run`, keeping its model-facing definition (name,
 * description, schema, `_tag`) identical. The new `run`'s `input` is typed from
 * the original tool, so override/mock need no annotation:
 *
 *   const safe = { ...toolkit, send_email: Tool.withRun(toolkit.send_email,
 *     ({ to }) => Effect.succeed({ status: "dry-run", to })) }
 *
 * Descriptors stay identical to production, so a mocked toolkit can't drift
 * from the contract the model sees.
 */
export const withRun = <Name extends string, Input, Event, Output, R, Output2, R2 = never>(
  tool: Tool<Name, Input, Event, Output, R>,
  run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output2, unknown, R2>,
): Tool<Name, Input, Event, Output2, R2> => ({ ...tool, run })

/** Render tools to provider-agnostic descriptors. Every kind is model-visible. */
export const toDescriptors = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolDescriptor> =>
  tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
    // `strict` only exists on local/provider kinds; signals/interactions omit it.
    const strict = "strict" in tool ? tool.strict : undefined
    return strict !== undefined
      ? { name: tool.name, description: tool.description, inputSchema, strict }
      : { name: tool.name, description: tool.description, inputSchema }
  })

/**
 * Render a `Toolkit` (a name-indexed record of tools) to descriptors, treating
 * an absent toolkit as no tools. The normalization point the `LanguageModel`
 * boundary uses so a request can carry the toolkit itself instead of a
 * pre-rendered descriptor array. Lives here (not on `Toolkit`) to keep providers
 * free of a dependency on the toolkit module — it only needs the tool values.
 */
export const descriptorsOf = (
  toolkit?: Readonly<Record<string, AnyTool>>,
): ReadonlyArray<ToolDescriptor> =>
  toolkit === undefined ? [] : toDescriptors(Object.values(toolkit))

const toToolError = (call: ToolCall, toolName: string, message: string) => (cause: unknown) =>
  new ToolError({ call_id: call.call_id, tool: toolName, message, cause })

/**
 * Decode and validate a function_call's JSON `arguments` against the tool's
 * own `inputSchema`, yielding the typed input. The decode-only half of
 * `execute` - reach for it when you intercept a call to translate it into a
 * control-flow decision rather than running the tool's `run`.
 *
 * Malformed JSON fails with `ToolError`; a parsed body that violates
 * `inputSchema` fails with `ToolValidationError` carrying the issues.
 */
export const decodeArgs = <Input>(
  tool: DecodableTool<Input>,
  call: ToolCall,
): Effect.Effect<Input, ToolError | ToolValidationError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      // inputSchema validates through Standard Schema, not Effect Schema, so its
      // JSON codecs don't apply; the parse is separate to keep ToolError (bad
      // JSON) distinct from ToolValidationError (bad shape).
      // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
      try: () => JSON.parse(call.arguments) as unknown,
      catch: toToolError(call, tool.name, "Failed to parse JSON arguments"),
    })

    const result = yield* Effect.promise(() =>
      Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
    )
    if (result.issues !== undefined) {
      return yield* new ToolValidationError({
        call_id: call.call_id,
        tool: tool.name,
        issues: result.issues,
      })
    }
    return result.value
  })

/**
 * Decode and validate the JSON arguments of a function_call against the
 * tool's input schema, run the tool, and serialize the output into a
 * function_call_output item. Single-shot: intermediate events emitted by
 * `run` are discarded (use `Toolkit.run` to stream them).
 */
export const execute = <Name extends string, Input, Event, Output, R>(
  tool: Tool<Name, Input, Event, Output, R>,
  call: ToolCall,
): Effect.Effect<ToolCallOutput, ToolError | ToolValidationError, R> =>
  decodeArgs(tool, call).pipe(
    Effect.flatMap((input) =>
      tool
        .run(input, () => Effect.void)
        .pipe(Effect.mapError(toToolError(call, tool.name, "Tool execution failed"))),
    ),
    Effect.map((output) => toolCallOutput(call.call_id, JSON.stringify(output))),
  )
