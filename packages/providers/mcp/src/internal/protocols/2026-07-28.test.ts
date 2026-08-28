import { describe, it } from "@effect/vitest"
import { Cause, Effect, Option, Queue, Stream } from "effect"
import { expect } from "vitest"
import { McpUnsupportedProtocol } from "../../McpError.js"
import { open, type SendMeta, type Transport } from "../rpc.js"
import { LATEST_VERSION, META_PROTOCOL_VERSION } from "../schema.js"
import { probe } from "./2026-07-28.js"

type Sent = { readonly frame: string; readonly meta: SendMeta | undefined }

/**
 * A scripted server: `reply` sees each parsed request and returns the JSON-RPC
 * body to answer with (`undefined` stays silent).
 */
const scripted = (reply: (request: Record<string, any>) => unknown) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.make<string, Cause.Done>()
    const sent: Array<Sent> = []
    const transport: Transport = {
      send: (frame, meta) =>
        Effect.gen(function* () {
          sent.push({ frame, meta })
          const request = JSON.parse(frame) as Record<string, any>
          const body = reply(request)
          if (body !== undefined) {
            yield* Queue.offer(
              inbox,
              JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(body as object) }),
            )
          }
        }),
      messages: Stream.fromQueue(inbox),
    }
    return { transport, sent }
  })

// Spec-conformant servers identify themselves in the result's `_meta`, not at
// the top level. Verified against Hugging Face, which does exactly this.
const discovered = {
  result: {
    resultType: "complete",
    supportedVersions: [LATEST_VERSION],
    capabilities: { tools: {} },
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: "scripted",
        version: "1.0.0",
        title: "Scripted",
        websiteUrl: "https://example.com",
      },
    },
  },
}

const unsupported = (supported: ReadonlyArray<string>) => ({
  error: {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported, requested: "1900-01-01" },
  },
})

const runProbe = (reply: (request: Record<string, any>) => unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sent, transport } = yield* scripted(reply)
      const connection = yield* open(transport, () => Effect.void)
      const protocol = yield* probe(connection)
      return { protocol, sent }
    }),
  )

describe("2026-07-28 probe", () => {
  it.effect("negotiates the stateless protocol from a server/discover result", () =>
    Effect.gen(function* () {
      const { protocol } = yield* runProbe(() => discovered)
      const value = Option.getOrThrow(protocol)
      expect(value.version).toBe(LATEST_VERSION)
      expect(value.serverInfo.name).toBe("scripted")
    }),
  )

  it.effect("keeps the MCP-Protocol-Version header equal to the _meta version", () =>
    Effect.gen(function* () {
      // A divergence between the two is exactly what servers reject with -32020.
      const { sent } = yield* runProbe(() => discovered)
      const frame = JSON.parse(sent[0]?.frame ?? "{}") as Record<string, any>
      expect(sent[0]?.meta?.headers?.["MCP-Protocol-Version"]).toBe(
        frame.params._meta[META_PROTOCOL_VERSION],
      )
    }),
  )

  it.effect("retries on a mutually supported version after a -32022", () =>
    Effect.gen(function* () {
      let attempts = 0
      const { protocol, sent } = yield* runProbe(() => {
        attempts += 1
        return attempts === 1 ? unsupported([LATEST_VERSION]) : discovered
      })
      expect(sent).toHaveLength(2)
      expect(Option.getOrThrow(protocol).version).toBe(LATEST_VERSION)
    }),
  )

  it.effect("fails typed when the server shares no supported version", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runProbe(() => unsupported(["1999-01-01"])))
      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(McpUnsupportedProtocol)
      expect((error as McpUnsupportedProtocol).offered).toEqual(["1999-01-01"])
    }),
  )

  it.effect("yields None on a non-modern error so the caller falls back to the handshake", () =>
    Effect.gen(function* () {
      const { protocol } = yield* runProbe(() => ({
        error: { code: -32601, message: "Method not found" },
      }))
      expect(Option.isNone(protocol)).toBe(true)
    }),
  )

  it.effect("Base64-encodes an Mcp-Name that is not header-safe", () =>
    Effect.gen(function* () {
      const { protocol } = yield* runProbe(() => discovered)
      const { headers } = Option.getOrThrow(protocol).meta("tools/call", { name: "Hello, 世界" })
      expect(headers?.["Mcp-Name"]).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=")
    }),
  )
})
