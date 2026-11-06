import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Input from "@effect-uai/ui/Input"
import * as RunView from "@effect-uai/ui/RunView"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { chat } from "../chat"
import type { ChatPayloads } from "../chat-ui"

export const Route = createFileRoute("/")({ component: Chat })

type Run = RunView.RunView<ChatPayloads>

// The answer, or the refusal when the model declined.
const answer = (run: Run) => RunView.text(run) || (RunView.refusal(run) ?? "")

const notes = (run: Run): ReadonlyArray<string> => {
  if (run.status === "stopped") return ["stopped"]
  if (run.status === "failed") return [`failed: ${run.error?.reason}`]
  return []
}

// Tool calls, typed by the contract: narrowing by name gives the tool's output.
const toolLine = (block: RunView.Block<ChatPayloads>): ReadonlyArray<string> => {
  if (block.type !== "tool") return []
  if (block.name === "get_weather" && block.output !== undefined) {
    const { city, temperatureC, sky } = block.output
    return [`get_weather: ${city}, ${temperatureC}°C, ${sky}`]
  }
  if (block.name === "get_date" && block.output !== undefined) {
    const { timezone, now } = block.output
    return [`get_date: ${now.toLocaleString(undefined, { timeZone: timezone })} (${timezone})`]
  }
  return [`${block.name}: ${block.status}`]
}

function Bubble(props: {
  role: "user" | "assistant"
  text: string
  notes?: ReadonlyArray<string>
}) {
  return (
    <div className={props.role}>
      {props.text}
      {props.notes?.map((note) => (
        <small key={note}>{note}</small>
      ))}
    </div>
  )
}

function Assistant(props: { run: Run; live: boolean }) {
  const tools = props.run.blocks.flatMap(toolLine)
  const text = answer(props.run)
  if (!props.live) {
    return <Bubble role="assistant" text={text} notes={[...tools, ...notes(props.run)]} />
  }
  return text === "" ? (
    <Bubble role="assistant" text="…" notes={[...tools, "thinking"]} />
  ) : (
    <Bubble role="assistant" text={text} notes={[...tools, "streaming"]} />
  )
}

function Chat() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  const stop = useAtomSet(chat.stop)
  const [prompt, setPrompt] = useState("")
  const active = thread.active
  const busy = active !== null

  return (
    <main>
      <h1>TanStack Start chat</h1>
      <div id="log">
        {thread.messages.map((m) =>
          m.role === "user" ? (
            <Bubble key={m.id} role="user" text={Input.text(m.value)} />
          ) : (
            <Assistant key={m.id} run={m.value} live={false} />
          ),
        )}
        {active !== null && <Assistant run={active} live />}
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
          placeholder="Ask about the weather, or today's date"
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
