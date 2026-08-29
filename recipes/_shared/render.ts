/**
 * Shared console renderer for agent-loop recipes: assistant prose streams
 * inline, tool calls print in cyan with their arguments, and each result shows
 * dim underneath. Recipes rendering a loop this way should use this rather
 * than re-deriving it.
 */
import { Effect, Match } from "effect"
import { ToolEvent } from "@effect-uai/core/ToolEvent"
import { ToolResult } from "@effect-uai/core/ToolResult"
import type { TurnEvent } from "@effect-uai/core/Turn"

/** What an agent loop emits: model events plus tool-execution events. */
export type LoopEvent = TurnEvent | ToolEvent

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
export const reset = "\x1b[0m"

export type RenderOptions = {
  /**
   * Cap the rendered length of a tool result. Prose-heavy tools (MCP servers,
   * search) would otherwise flood the terminal. Unset prints the whole value.
   */
  readonly maxResultChars?: number
}

const truncate = (s: string, max: number | undefined): string =>
  max === undefined || s.length <= max ? s : `${s.slice(0, max)}…`

const renderResult = (result: ToolResult, max: number | undefined): string =>
  ToolResult.$match(result, {
    Ok: ({ value }) => truncate(JSON.stringify(value), max),
    Failure: ({ kind, reason }) => `failed: ${kind}${reason === undefined ? "" : ` (${reason})`}`,
  })

/**
 * Render one loop event to stdout. Pass to `Stream.runForEach`:
 *
 *   Stream.runForEach(events, renderEvent({ maxResultChars: 300 }))
 */
export const renderEvent =
  (options: RenderOptions = {}) =>
  (event: LoopEvent): Effect.Effect<void> =>
    Match.value(event).pipe(
      Match.tag("TextDelta", ({ text }) => write(text)),
      Match.tag("ToolCallStart", ({ name }) => write(`\n${cyan(`🔧 ${name}`)} `)),
      Match.tag("ToolCallArgsDelta", ({ delta }) => write(delta)),
      Match.tag("Output", ({ result }) =>
        write(`${dim(`   ↳ ${renderResult(result, options.maxResultChars)}`)}\n`),
      ),
      // Reset any dim styling and break the line at the end of a turn.
      Match.tag("TurnComplete", () => write(`${reset}\n`)),
      Match.orElse(() => Effect.void),
    )
