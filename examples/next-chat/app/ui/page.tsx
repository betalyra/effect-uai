"use client"

import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Input from "@effect-uai/ui/Input"
import * as RunView from "@effect-uai/ui/RunView"
import { useEffect, useRef, useState } from "react"
import type { ChatPayloads } from "../../lib/chat-ui"
import { chat } from "../../lib/ui-chat"

type Run = RunView.RunView<ChatPayloads>
type Block = RunView.Block<ChatPayloads>

// The same chat as `/`, on `@effect-uai/ui`: the server keeps the history,
// and tool blocks arrive decoded by the shared contract.
export default function Page() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  const stop = useAtomSet(chat.stop)
  const [input, setInput] = useState("")
  const busy = thread.active !== null

  // Keep the latest content in view as the answer streams in.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread])

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-6">
      <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {thread.messages.map((m) =>
          m.role === "user" ? (
            <UserMessage key={m.id} text={Input.text(m.value)} />
          ) : (
            <Assistant key={m.id} run={m.value} />
          ),
        )}
        {thread.active !== null && <Assistant run={thread.active} />}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (input.trim().length === 0 || busy) return
          submit(Input.submit(input))
          setInput("")
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about the weather, or the time somewhere…"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => stop()}
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

function UserMessage({ text }: { readonly text: string }) {
  return (
    <div className="self-end text-right">
      <Role>user</Role>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
    </div>
  )
}

function Assistant({ run }: { readonly run: Run }) {
  return (
    <div className="self-start">
      <Role>assistant</Role>
      <div className="flex flex-col gap-2">
        {run.blocks.map((block) => (
          <BlockView key={block.id} block={block} />
        ))}
        {run.status === "submitted" && <p className="text-sm text-neutral-500">…</p>}
        {run.status === "stopped" && <Note>stopped</Note>}
        {run.status === "failed" && <Note>failed: {run.error?.reason}</Note>}
      </div>
      {run.usage && (
        <Note>
          tokens in={run.usage.input_tokens ?? "?"} out={run.usage.output_tokens ?? "?"}
        </Note>
      )}
    </div>
  )
}

function BlockView({ block }: { readonly block: Block }) {
  if (block.type === "output_text") {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed">{block.text}</p>
  }
  if (block.type === "refusal") {
    return <p className="text-sm text-amber-400">{block.text}</p>
  }
  if (block.type === "reasoning") {
    return (
      <details className="text-sm text-neutral-400">
        <summary className="cursor-pointer select-none">💭 reasoning</summary>
        <p className="mt-1 whitespace-pre-wrap">{block.text}</p>
      </details>
    )
  }
  if (block.type === "tool") return <ToolCard block={block} />
  return null
}

// Narrowing by name gives the tool's own output type: `observedAt` and `now`
// are `Date`s, decoded by the contract.
function ToolCard({ block }: { readonly block: Extract<Block, { type: "tool" }> }) {
  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900 p-2 text-left font-mono text-xs">
      <div className="flex items-center gap-2">
        <span>🔧 {block.name}</span>
        <span className="text-neutral-500">{block.status}</span>
      </div>
      <div className="mt-1 text-emerald-300">{toolSummary(block)}</div>
      {block.error !== undefined && (
        <div className="mt-1 text-red-400">{JSON.stringify(block.error)}</div>
      )}
    </div>
  )
}

const toolSummary = (block: Extract<Block, { type: "tool" }>): string => {
  if (block.name === "get_weather" && block.output !== undefined) {
    const { city, country, temperatureC, windSpeedKmh, observedAt } = block.output
    return `${city}, ${country}: ${temperatureC}°C, wind ${windSpeedKmh} km/h (${observedAt.toLocaleTimeString()})`
  }
  if (block.name === "get_date" && block.output !== undefined) {
    const { timezone, now } = block.output
    return `${now.toLocaleString(undefined, { timeZone: timezone })} (${timezone})`
  }
  return block.input === undefined ? "" : JSON.stringify(block.input)
}

function Role({ children }: { readonly children: string }) {
  return (
    <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">
      {children}
    </div>
  )
}

function Note({ children }: { readonly children: React.ReactNode }) {
  return <div className="mt-1 font-mono text-[10px] text-neutral-600">{children}</div>
}
