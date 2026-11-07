"use client"

import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Input from "@effect-uai/ui/Input"
import * as RunView from "@effect-uai/ui/RunView"
import type * as Thread from "@effect-uai/ui/Thread"
import { Option, Schema } from "effect"
import { useState } from "react"
import { Streamdown } from "streamdown"
import type { ChatPayloads } from "../lib/chat-ui"
import { chat } from "../lib/ui-chat"

type Run = RunView.RunView<ChatPayloads>
type ToolBlock = Extract<RunView.Block<ChatPayloads>, { type: "tool" }>

// The answer, or the refusal when the model declined.
const answer = (run: Run) => RunView.text(run) || (RunView.refusal(run) ?? "")

const runNote = (run: Run): string | undefined => {
  if (run.status === "stopped") return "stopped"
  if (run.status === "failed") return `failed: ${run.error?.reason}`
  return undefined
}

// A failed call carries the server's `kind`; what it means is ours to word.
const kindOf = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }))

const failure = (block: ToolBlock): string => {
  const kind = Option.match(kindOf(block.error), { onNone: () => "error", onSome: (e) => e.kind })
  if (kind === "denied") return "you declined"
  if (kind === "superseded") return "skipped: you asked something else"
  return `failed: ${kind}`
}

// Narrowing by name gives the tool's own types: `observedAt`, `now`, `sentAt` are Dates.
const toolSummary = (block: ToolBlock): string => {
  if (block.status === "failed") return `${block.name}: ${failure(block)}`
  if (block.name === "get_weather" && block.output !== undefined) {
    const { city, country, temperatureC, windSpeedKmh, observedAt } = block.output
    return `${city}, ${country}: ${temperatureC}°C, wind ${windSpeedKmh} km/h (${observedAt.toLocaleTimeString()})`
  }
  if (block.name === "get_date" && block.output !== undefined) {
    const { timezone, now } = block.output
    return `${now.toLocaleString(undefined, { timeZone: timezone })} (${timezone})`
  }
  if (block.name === "send_email" && block.input !== undefined) {
    const sent = block.output?.sentAt
    return sent === undefined
      ? `email to ${block.input.to}: "${block.input.subject}"`
      : `email sent to ${block.input.to} at ${sent.toLocaleTimeString()}`
  }
  if (block.name === "book_table" && block.input !== undefined) {
    const { restaurant, time, guests } = block.input
    return `${restaurant}, ${time}, ${guests} guests${block.output === undefined ? "" : ": booked"}`
  }
  return `${block.name}: ${block.status}`
}

function ToolCard(props: { block: ToolBlock }) {
  const submit = useAtomSet(chat.submit)
  const { block } = props
  // The page only votes; the server checks the call is waiting, and decides.
  const vote = (approved: boolean) => submit(Input.resolve([{ callId: block.id, approved }]))
  return (
    <div className="tool">
      <span>{toolSummary(block)}</span>
      {block.status === "awaiting-approval" && (
        <>
          <button type="button" onClick={() => vote(true)}>
            Approve
          </button>
          <button type="button" onClick={() => vote(false)}>
            Deny
          </button>
        </>
      )}
    </div>
  )
}

const liveNote = (text: string) => (text === "" ? "thinking" : "streaming")

// A verdict has no text; only messages show as bubbles.
function UserBubble(props: { value: Thread.UserContent }) {
  const text = Input.text(props.value)
  return text === "" ? null : <div className="user">{text}</div>
}

// Live metrics (the contract's `live` values) while it streams; token usage once known.
const stats = (run: Run): ReadonlyArray<string> => [
  ...(run.live.ttftMs === undefined ? [] : [`TTFT ${run.live.ttftMs} ms`]),
  ...(run.live.tokensPerSecond === undefined ? [] : [`${run.live.tokensPerSecond} tok/s`]),
  ...(run.usage?.output_tokens === undefined
    ? []
    : [`${run.usage.input_tokens ?? "?"} in / ${run.usage.output_tokens} out tokens`]),
]

function Assistant(props: { run: Run; live: boolean }) {
  const text = answer(props.run)
  const note = props.live ? liveNote(text) : runNote(props.run)
  const line = [...(note === undefined ? [] : [note]), ...stats(props.run)].join(" · ")
  return (
    <div className="assistant">
      {text === "" && props.live ? "…" : <Streamdown className="markdown">{text}</Streamdown>}
      {props.run.blocks.flatMap((b) =>
        b.type === "tool" ? [<ToolCard key={b.id} block={b} />] : [],
      )}
      {line !== "" && <small>{line}</small>}
    </div>
  )
}

// On `@effect-uai/ui`: the server keeps the history, tool blocks arrive decoded
// by the shared contract, and some need approval. `/ai-sdk` is the same chat on useChat.
export default function Page() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  const stop = useAtomSet(chat.stop)
  const [prompt, setPrompt] = useState("")
  const busy = thread.active !== null

  return (
    <main>
      <h1>Next.js chat · @effect-uai/ui</h1>
      <div id="log">
        <div>
          {thread.messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} value={m.value} />
            ) : (
              <Assistant key={m.id} run={m.value} live={false} />
            ),
          )}
          {thread.active !== null && <Assistant run={thread.active} live />}
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const text = prompt.trim()
          if (text === "") return
          submit(Input.submit(text))
          setPrompt("")
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask about the weather, or to send an email or book a table"
          autoFocus
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
        <button type="button" disabled={!busy} onClick={() => stop()}>
          Stop
        </button>
      </form>
    </main>
  )
}
