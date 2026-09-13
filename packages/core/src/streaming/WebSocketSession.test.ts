import { describe, it } from "@effect/vitest"
import * as Socket from "effect/unstable/socket/Socket"
import { expect } from "vitest"
import * as AiError from "../domain/AiError.js"
import { toAiError } from "./WebSocketSession.js"

const KEY = "AIzaSyEXAMPLEKEY"
const URL = `wss://generativelanguage.googleapis.com/ws/BidiGenerateContent?key=${KEY}`

/**
 * What Bun hands the `error` listener when the upgrade is rejected: the whole
 * socket URL, in prose, on a prototype getter. Node and Deno say less, but the
 * adapter cannot know which runtime it is on.
 */
class BunErrorEvent {
  get message(): string {
    return `WebSocket connection to '${URL}' failed: Connection ended`
  }
}

/** Deno names the status but not the URL, also on a prototype getter. */
class DenoErrorEvent {
  constructor(private readonly detail: string) {}
  get message(): string {
    return `NetworkError: failed to connect to WebSocket: ${this.detail}`
  }
}

const openFailure = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })

describe("WebSocketSession errors", () => {
  it("keeps the key out of the error a rejected upgrade produces", () => {
    const error = toAiError("google")(openFailure(new BunErrorEvent()))

    expect(JSON.stringify(error)).not.toContain(KEY)
    expect(AiError.describe(error)).not.toContain(KEY)
    // The host is still there: an error that says nothing is its own problem.
    expect(JSON.stringify(error)).toContain("generativelanguage.googleapis.com")
  })

  it("reads the rejected status out of the prose, wherever the runtime put it", () => {
    // Deno's wording. The status is the only hint a rejected upgrade gives.
    const forbidden = toAiError("google")(
      openFailure(new DenoErrorEvent("Invalid status code: 403")),
    )
    const ended = toAiError("google")(openFailure(new BunErrorEvent()))

    expect(forbidden._tag).toBe("AuthFailed")
    expect(ended._tag).toBe("Unavailable")
  })
})
