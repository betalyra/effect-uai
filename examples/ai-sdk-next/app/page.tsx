"use client"

import { useChat } from "@ai-sdk/react"
import { useEffect, useRef, useState } from "react"
import type { UIMessage } from "ai"

// The live-metrics badge is fed by transient `data-metrics` parts (server →
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

  // Keep the latest content in view as the answer streams in.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, metrics])

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-6">
      <h1 className="shrink-0 font-mono text-sm text-neutral-400">effect-uai × AI SDK</h1>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
      </div>

      {busy && <MetricsBadge metrics={metrics} />}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (input.trim().length === 0 || busy) return
          sendMessage({ text: input })
          setInput("")
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about the weather somewhere…"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
          >
            Send
          </button>
        )}
      </form>
    </main>
  )
}

function Message({ message }: { readonly message: UIMessage }) {
  const usage = (message.metadata as { usage?: Usage } | undefined)?.usage
  const mine = message.role === "user"

  return (
    <div className={mine ? "self-end text-right" : "self-start"}>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">
        {message.role}
      </div>
      <div className="flex flex-col gap-2">
        {message.parts.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </div>
      {usage && <UsageFooter usage={usage} />}
    </div>
  )
}

function Part({ part }: { readonly part: UIMessage["parts"][number] }) {
  if (part.type === "text") {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed">{part.text}</p>
  }
  if (part.type === "reasoning") {
    return (
      <details className="text-sm text-neutral-400">
        <summary className="cursor-pointer select-none">💭 reasoning</summary>
        <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
      </details>
    )
  }
  if (part.type.startsWith("tool-")) {
    return <ToolCard part={part as ToolPart} />
  }
  return null
}

type ToolPart = {
  readonly type: string
  readonly state: string
  readonly input?: unknown
  readonly output?: unknown
}

function ToolCard({ part }: { readonly part: ToolPart }) {
  const name = part.type.replace(/^tool-/, "")
  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900 p-2 text-left">
      <div className="flex items-center gap-2 font-mono text-xs">
        <span>🔧 {name}</span>
        <span className="text-neutral-500">{part.state}</span>
      </div>
      {part.input !== undefined && (
        <pre className="mt-1 overflow-x-auto text-xs text-neutral-400">
          {JSON.stringify(part.input)}
        </pre>
      )}
      {part.output !== undefined && (
        <pre className="mt-1 overflow-x-auto text-xs text-emerald-300">
          {JSON.stringify(part.output)}
        </pre>
      )}
    </div>
  )
}

function MetricsBadge({ metrics }: { readonly metrics: Metrics }) {
  return (
    <div className="flex gap-3 font-mono text-xs text-neutral-500">
      {metrics.ttftMs !== undefined && <span>TTFT {metrics.ttftMs}ms</span>}
      {metrics.tokps !== undefined && <span>~{metrics.tokps} tok/s</span>}
    </div>
  )
}

function UsageFooter({ usage }: { readonly usage: Usage }) {
  return (
    <div className="mt-1 font-mono text-[10px] text-neutral-600">
      tokens in={usage.input_tokens ?? "?"} out={usage.output_tokens ?? "?"}
    </div>
  )
}
