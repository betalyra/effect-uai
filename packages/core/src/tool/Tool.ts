import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Match, Schema } from "effect"
import type { ToolCall, ToolCallOutput } from "../domain/Items.js"
import { toolCallOutput } from "../domain/Items.js"
import { serializeValue } from "./ToolResult.js"

export class ToolError extends Schema.TaggedError<ToolError>("@betalyra/effect-uai/ToolError")(
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
export class ToolValidationError extends Schema.TaggedError<ToolValidationError>(
  "@betalyra/effect-uai/ToolValidationError",
)("ToolValidationError", {
  call_id: Schema.String,
  tool: Schema.String,
  issues: Schema.Array(ToolValidationIssue),
}) {}

/**
 * The deliberate "speak to the model" failure sentinel. A tool's `run` that
 * fails with a `ToolFailed` (or a bare `string`, its sugar) is absorbed by
 * `Toolkit.run` into a `ToolResult.Failure` the model reads and adapts to,
 * instead of ending the run. Every other error type propagates typed on the
 * executor's stream. `kind` overrides the synthesized `Failure.kind`
 * (default `"tool_failed"`) so a tool can hand the model a distinguishable
 * category (`"not_found"`, `"rate_limited"`) without a new result variant.
 */
export class ToolFailed extends Schema.TaggedError<ToolFailed>("@betalyra/effect-uai/ToolFailed")(
  "ToolFailed",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
  },
) {}

/**
 * Fail a tool's `run` with a model-visible message (optionally a `kind`).
 * `yield* Tool.fail("page not found", { kind: "not_found" })` inside a
 * `run`'s `Effect.gen`; the executor absorbs it as `ToolResult.Failure`.
 */
export const fail = (
  message: string,
  options?: { readonly kind?: string },
): Effect.Effect<never, ToolFailed> =>
  Effect.fail(
    new ToolFailed({ message, ...(options?.kind !== undefined ? { kind: options.kind } : {}) }),
  )

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
 * Input schema for a tool that takes no arguments. Renders a clean
 * `{ type: "object", properties: {} }`; validation accepts anything and
 * yields `{}`. Use it instead of `fromEffectSchema(Schema.Struct({}))`,
 * which renders a degenerate `anyOf` (object-or-array) that strict
 * providers like Gemini reject.
 */
export const noInput: ToolInputSchema<Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "effect-uai",
    validate: () => ({ value: {} }),
    jsonSchema: {
      input: () => ({ type: "object", properties: {} }),
      output: () => ({ type: "object", properties: {} }),
    },
  },
}

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
export type Tool<Name extends string, Input, Event, Output, E = unknown, R = never> = {
  readonly _tag: "LocalTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output, E, R>
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
export type AnyLocalTool<E = any, R = any> = Tool<string, any, any, any, E, R>

/** Any of the four model-visible tool kinds. */
export type AnyTool<E = any, R = any> =
  | Tool<string, any, any, any, E, R>
  | ProviderTool<string, any, string, any>
  | SignalTool<string, any>
  | InteractionTool<string, any>

/** A model-visible tool that carries a decodable input schema (every kind). */
export type DecodableTool<Input> = {
  readonly name: string
  readonly inputSchema: ToolInputSchema<Input>
}

/** Extract the `R` of a local tool; non-local kinds contribute `never`. */
export type ToolR<T> = T extends Tool<string, any, any, any, any, infer R> ? R : never

/** Extract the `E` of a local tool; non-local kinds contribute `never`. */
export type ToolE<T> = T extends Tool<string, any, any, any, infer E, any> ? E : never

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

const resolveInputSchema = (
  schema: ToolInputSchema<any> | Schema.Codec<any, any, never, any>,
): ToolInputSchema<any> =>
  Schema.isSchema(schema)
    ? fromEffectSchema(schema as Schema.Codec<any, any, never, any>)
    : (schema as ToolInputSchema<any>)

/** A model-visible tool with a local `Effect` executor. */
export const make: {
  <
    Name extends string,
    S extends Schema.Codec<any, any, never, any>,
    Event,
    Output,
    E = never,
    R = never,
  >(
    spec: Omit<Tool<Name, S["Type"], Event, Output, E, R>, "_tag" | "inputSchema"> & {
      readonly inputSchema: S
    },
  ): Tool<Name, S["Type"], Event, Output, E, R>
  <Name extends string, Input, Event, Output, E = never, R = never>(
    spec: Omit<Tool<Name, Input, Event, Output, E, R>, "_tag">,
  ): Tool<Name, Input, Event, Output, E, R>
} = (
  spec: Omit<AnyLocalTool, "_tag" | "inputSchema"> & {
    readonly inputSchema: ToolInputSchema<any> | Schema.Codec<any, any, never, any>
  },
): AnyLocalTool => ({
  _tag: "LocalTool",
  ...spec,
  inputSchema: resolveInputSchema(spec.inputSchema),
})

/**
 * A provider-hosted tool (native web search, code execution, RAG grounding).
 * No local executor — `provider`/`config` drive the provider adapter's
 * rendering. The model sees it; `Toolkit.run` reports it as `non_local_tool`.
 */
export const provider: {
  <
    Name extends string,
    S extends Schema.Codec<any, any, never, any>,
    Provider extends string,
    Config,
  >(
    spec: Omit<ProviderTool<Name, S["Type"], Provider, Config>, "_tag" | "inputSchema"> & {
      readonly inputSchema: S
    },
  ): ProviderTool<Name, S["Type"], Provider, Config>
  <Name extends string, Input, Provider extends string, Config>(
    spec: Omit<ProviderTool<Name, Input, Provider, Config>, "_tag">,
  ): ProviderTool<Name, Input, Provider, Config>
} = (
  spec: Omit<ProviderTool<string, any, string, any>, "_tag" | "inputSchema"> & {
    readonly inputSchema: ToolInputSchema<any> | Schema.Codec<any, any, never, any>
  },
): ProviderTool<string, any, string, any> => ({
  _tag: "ProviderTool",
  ...spec,
  inputSchema: resolveInputSchema(spec.inputSchema),
})

/**
 * A typed control-flow signal to the agent loop (escalate, pause, schedule,
 * hand off). Decode-only: the loop interprets the call rather than executing a
 * handler, so there is no `run`.
 */
export const signal: {
  <Name extends string, S extends Schema.Codec<any, any, never, any>>(
    spec: Omit<SignalTool<Name, S["Type"]>, "_tag" | "inputSchema"> & {
      readonly inputSchema: S
    },
  ): SignalTool<Name, S["Type"]>
  <Name extends string, Input>(spec: Omit<SignalTool<Name, Input>, "_tag">): SignalTool<Name, Input>
} = (
  spec: Omit<SignalTool<string, any>, "_tag" | "inputSchema"> & {
    readonly inputSchema: ToolInputSchema<any> | Schema.Codec<any, any, never, any>
  },
): SignalTool<string, any> => ({
  _tag: "SignalTool",
  ...spec,
  inputSchema: resolveInputSchema(spec.inputSchema),
})

/**
 * A typed request for an external actor to respond before the loop resumes
 * (frontend, Telegram, CLI prompt). Decode-only; the loop stops/pauses and
 * resumes by appending the actor's `function_call_output`.
 */
export const interaction: {
  <Name extends string, S extends Schema.Codec<any, any, never, any>>(
    spec: Omit<InteractionTool<Name, S["Type"]>, "_tag" | "inputSchema"> & {
      readonly inputSchema: S
    },
  ): InteractionTool<Name, S["Type"]>
  <Name extends string, Input>(
    spec: Omit<InteractionTool<Name, Input>, "_tag">,
  ): InteractionTool<Name, Input>
} = (
  spec: Omit<InteractionTool<string, any>, "_tag" | "inputSchema"> & {
    readonly inputSchema: ToolInputSchema<any> | Schema.Codec<any, any, never, any>
  },
): InteractionTool<string, any> => ({
  _tag: "InteractionTool",
  ...spec,
  inputSchema: resolveInputSchema(spec.inputSchema),
})

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
export const withRun = <
  Name extends string,
  Input,
  Event,
  Output,
  E,
  R,
  Output2,
  E2 = never,
  R2 = never,
>(
  tool: Tool<Name, Input, Event, Output, E, R>,
  run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output2, E2, R2>,
): Tool<Name, Input, Event, Output2, E2, R2> => ({ ...tool, run })

/** True for provider-hosted tools — the kind a provider renders natively. */
export const isProviderTool = (tool: AnyTool): tool is ProviderTool<string, any, string, any> =>
  tool._tag === "ProviderTool"

/**
 * The `ProviderTool`s in a toolkit, for a provider adapter to render as its
 * native hosted-tool entries (web search, code execution, grounding). The other
 * kinds render as function declarations via `descriptorsOf`.
 */
export const providerToolsOf = (
  toolkit?: Readonly<Record<string, AnyTool>>,
): ReadonlyArray<ProviderTool<string, any, string, any>> =>
  toolkit === undefined ? [] : Object.values(toolkit).filter(isProviderTool)

/**
 * Render tools to provider-agnostic descriptors. `ProviderTool`s are excluded:
 * they are provider-hosted and must never leak into the function-declaration
 * list — each adapter renders them natively via `providerToolsOf`. Every other
 * kind is model-visible as a declaration.
 */
export const toDescriptors = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolDescriptor> =>
  tools
    .filter((tool) => !isProviderTool(tool))
    .map((tool) => {
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

/**
 * Outcome of decoding a call's `arguments` against a tool's `inputSchema`,
 * as data so both the typed (`decodeArgs`) and result-synthesizing
 * (`Toolkit.run`) callers can translate it their own way.
 */
export type DecodeResult<Input> =
  | { readonly _tag: "ok"; readonly input: Input }
  | { readonly _tag: "parseError" }
  | { readonly _tag: "invalid"; readonly issues: ReadonlyArray<StandardSchemaV1.Issue> }

const VALIDATION_THREW: ReadonlyArray<StandardSchemaV1.Issue> = [
  { message: "input schema validation threw" },
]

/**
 * Parse and validate a call's `arguments`. Empty arguments normalize to
 * `{}` (some models emit `""` for zero-arg tools); a throwing validator is
 * captured, not propagated. Never fails.
 */
export const decodeCallInput = <Input>(
  tool: DecodableTool<Input>,
  call: ToolCall,
): Effect.Effect<DecodeResult<Input>> => {
  const raw = call.arguments.trim() === "" ? "{}" : call.arguments
  return Effect.try({
    // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
    try: () => JSON.parse(raw) as unknown,
    catch: (): DecodeResult<Input> => ({ _tag: "parseError" }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: (): DecodeResult<Input> => ({ _tag: "invalid", issues: VALIDATION_THREW }),
      }).pipe(
        Effect.map(
          (result): DecodeResult<Input> =>
            result.issues !== undefined
              ? { _tag: "invalid", issues: result.issues }
              : { _tag: "ok", input: result.value },
        ),
      ),
    ),
    Effect.catch((captured: DecodeResult<Input>) => Effect.succeed(captured)),
  )
}

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
  decodeCallInput(tool, call).pipe(
    Effect.flatMap(
      Match.type<DecodeResult<Input>>().pipe(
        Match.tag("ok", ({ input }) => Effect.succeed(input)),
        Match.tag("parseError", () =>
          Effect.fail(
            new ToolError({
              call_id: call.call_id,
              tool: tool.name,
              message: "Failed to parse JSON arguments",
            }),
          ),
        ),
        Match.tag("invalid", ({ issues }) =>
          Effect.fail(new ToolValidationError({ call_id: call.call_id, tool: tool.name, issues })),
        ),
        Match.exhaustive,
      ),
    ),
  )

/**
 * Decode and validate the JSON arguments of a function_call against the
 * tool's input schema, run the tool, and serialize the output into a
 * function_call_output item. Single-shot: intermediate events emitted by
 * `run` are discarded (use `Toolkit.run` to stream them).
 */
export const execute = <Name extends string, Input, Event, Output, E, R>(
  tool: Tool<Name, Input, Event, Output, E, R>,
  call: ToolCall,
): Effect.Effect<ToolCallOutput, E | ToolError | ToolValidationError, R> =>
  decodeArgs(tool, call).pipe(
    Effect.flatMap((input) => tool.run(input, () => Effect.void)),
    Effect.map((output) => toolCallOutput(call.call_id, serializeValue(output))),
  )
