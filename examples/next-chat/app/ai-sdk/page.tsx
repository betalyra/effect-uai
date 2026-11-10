"use client"

import { useChat } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { useState } from "react"
import { Streamdown } from "streamdown"

// The live-metrics line is fed by transient `data-metrics` parts (server →
// onData); usage lands on message.metadata. Everything else is stock useChat.
type Metrics = { readonly ttftMs?: number; readonly tokps?: number }
type Usage = { readonly input_tokens?: number; readonly output_tokens?: number }

export default function Page() {
  const [input, setInput] = useState("")
  const [metrics, setMetrics] = useState<Metrics>({})

  const { messages, sendMessage, status, stop } = useChat({
    onData: (part) => {
      if (part.type === "data-metrics") setMetrics((m) => ({ ...m, ...(part.data as Metrics) }))
    },
  })

  const busy = status === "submitted" || status === "streaming"

  return (
    <main>
      <h1>Next.js chat · AI SDK useChat</h1>
      <div id="log">
        <div>
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {busy && <MetricsLine metrics={metrics} />}
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (input.trim().length === 0 || busy) return
          sendMessage({ text: input })
          setInput("")
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about the weather, or the time somewhere"
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

function Message({ message }: { readonly message: UIMessage }) {
  const usage = (message.metadata as { usage?: Usage } | undefined)?.usage
  return (
    <div className={message.role === "user" ? "user" : "assistant"}>
      {message.parts.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {usage && (
        <small>
          tokens in={usage.input_tokens ?? "?"} out={usage.output_tokens ?? "?"}
        </small>
      )}
    </div>
  )
}

type ToolPart = {
  readonly type: string
  readonly state: string
  readonly input?: unknown
  readonly output?: unknown
}

function Part({ part }: { readonly part: UIMessage["parts"][number] }) {
  if (part.type === "text") return <Streamdown className="markdown">{part.text}</Streamdown>
  if (part.type.startsWith("tool-")) {
    // AI SDK tool parts are untyped JSON here; the main page gets them typed.
    const tool = part as ToolPart
    return (
      <div className="tool">
        {tool.type.replace(/^tool-/, "")}: {JSON.stringify(tool.output ?? tool.input)}
      </div>
    )
  }
  return null
}

function MetricsLine({ metrics }: { readonly metrics: Metrics }) {
  return (
    <small>
      {metrics.ttftMs !== undefined && `TTFT ${metrics.ttftMs}ms `}
      {metrics.tokps !== undefined && `~${metrics.tokps} tok/s`}
    </small>
  )
}
