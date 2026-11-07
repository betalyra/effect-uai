/**
 * What `Toolkit.run` emits, typed per tool: `tool` is the discriminant, so
 * `e.tool === "search"` narrows `value` / `result` to that tool's types. Values
 * are decoded (the tool's own types); `Toolkit.output` encodes them for history.
 */
import type { Result } from "effect"

/** An intermediate value of a `Stream` tool. */
export type Partial<Name extends string = string, Output = unknown> = {
  readonly _tag: "Partial"
  readonly call_id: string
  readonly tool: Name
  readonly value: Output
}

/** The call ended: `Success` with its value, or `Failure` with a declared or core error. */
export type Output<Name extends string = string, Out = unknown, E = unknown> = {
  readonly _tag: "Output"
  readonly call_id: string
  readonly tool: Name
  readonly result: Result.Result<Out, E>
}

export type ToolEvent<Name extends string = string, Out = unknown, E = unknown> =
  | Partial<Name, Out>
  | Output<Name, Out, E>
