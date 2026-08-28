/**
 * MCP tools in a loop: connect to a real MCP server, turn its advertised tools
 * into a `Toolkit`, and let the model use them.
 *
 * The whole recipe is one `Stream`. The connection is acquired when the stream
 * is first pulled and released when it ends, so the caller never drains
 * anything inside a scope and never closes a client by hand:
 *
 *   fromEffect(connect) -> mapEffect(mcpToolkit) -> flatMap(loop) -> scoped
 *
 * Protocol era is negotiated at connect and invisible here: the same code runs
 * against a stateless 2026-07-28 server and a 2025-06-18 handshake server.
 */
import { Effect, pipe, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { connect, type McpClientConfig } from "@effect-uai/mcp/Client"
import { mcpToolkit } from "@effect-uai/mcp/Toolkit"

type State = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly index: number
}

/**
 * The agent loop, identical to the basic-usage recipe except the toolkit came
 * off a server instead of a literal. That is the point: MCP tools are ordinary
 * tools once `mcpToolkit` has run.
 */
const runLoop = (model: string, toolkit: Toolkit.Toolkit, prompt: string) =>
  pipe(
    { history: [Items.userText(prompt)], index: 0 } satisfies State,
    loop((state: State) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm.streamTurn({ history: state.history, model, tools: toolkit }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()
              return Toolkit.run(toolkit, calls).pipe(
                Toolkit.continueWithResults(
                  Toolkit.appendToolResults({ ...state, index: state.index + 1 }, turn),
                ),
              )
            }),
          ),
        )
      }),
    ),
  )

/**
 * Connection lifetime = stream lifetime. `Stream.scoped` binds the scope
 * `connect` requires to this stream, so the server is torn down when the
 * stream ends, fails, or is interrupted, with nothing to remember.
 */
export const makeConversation = (
  config: McpClientConfig,
  model: string,
  prompt: string,
  prefix?: string,
) =>
  Stream.fromEffect(connect(config)).pipe(
    Stream.tap((client) =>
      Effect.logInfo("[mcp] connected", {
        server: client.serverInfo.name,
        protocolVersion: client.serverInfo.protocolVersion,
      }),
    ),
    Stream.mapEffect((client) => mcpToolkit(client, ...(prefix === undefined ? [] : [{ prefix }]))),
    Stream.tap((kit) => Effect.logInfo("[mcp] tools", { tools: Object.keys(kit) })),
    Stream.flatMap((kit) => runLoop(model, kit, prompt)),
    Stream.scoped,
  )
