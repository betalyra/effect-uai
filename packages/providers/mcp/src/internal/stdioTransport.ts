/**
 * stdio `Transport`: spawn the server, frame stdout as JSONL (one JSON message
 * per line). Scoped, so the child is killed on scope close. Era-blind; the
 * `meta.headers` a caller passes are HTTP-only and ignored here.
 */
import { Cause, Effect, Queue, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as JSONL from "@effect-uai/core/JSONL"
import { McpConnectFailed, type McpError, McpTransportClosed } from "../McpError.js"
import type { Transport } from "./rpc.js"

export type StdioConfig = {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
  readonly cwd?: string
}

const encoder = new TextEncoder()

export const make = (
  config: StdioConfig,
): Effect.Effect<Transport, McpError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    // Outbound frames go through a queue rendered as the child's stdin stream;
    // `Queue.end` on scope close lets the child see a clean EOF.
    const outbound = yield* Queue.make<Uint8Array, Cause.Done>()
    const stdin = Stream.fromQueue(outbound)

    const handle = yield* ChildProcess.make(config.command, [...(config.args ?? [])], {
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
      stdin: { stream: stdin, endOnDone: true },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "2 seconds",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new McpConnectFailed({ reason: `could not spawn ${config.command}`, raw: cause }),
      ),
    )
    yield* Effect.addFinalizer(() => Queue.end(outbound))

    const send = (frame: string): Effect.Effect<void, McpError> =>
      Queue.offer(outbound, encoder.encode(`${frame}\n`)).pipe(
        Effect.mapError(
          (cause) =>
            new McpTransportClosed({ reason: "server stdin closed", raw: cause }) as McpError,
        ),
        Effect.asVoid,
      )

    const messages = handle.stdout.pipe(
      JSONL.fromBytes,
      Stream.mapError(
        (cause) => new McpTransportClosed({ reason: "server stdout closed", raw: cause }),
      ),
    )

    return { send, messages } satisfies Transport
  })
