import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Input from "@effect-uai/ui/Input"
import * as RunView from "@effect-uai/ui/RunView"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { chat } from "../chat"

export const Route = createFileRoute("/")({ component: Chat })

// The answer, or the refusal when the model declined.
const answer = (run: RunView.RunView) => RunView.text(run) || (RunView.refusal(run) ?? "")

const note = (run: RunView.RunView): string | undefined => {
  if (run.status === "stopped") return "stopped"
  if (run.status === "failed") return `failed: ${run.error?.reason}`
  return undefined
}

function Bubble(props: { role: "user" | "assistant"; text: string; note?: string | undefined }) {
  return (
    <div className={props.role}>
      {props.text}
      {props.note !== undefined && <small>{props.note}</small>}
    </div>
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
            <Bubble key={m.id} role="assistant" text={answer(m.value)} note={note(m.value)} />
          ),
        )}
        {active !== null && (
          <Bubble
            role="assistant"
            text={answer(active) || "…"}
            note={answer(active) === "" ? "thinking" : "streaming"}
          />
        )}
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
          placeholder="Ask anything"
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
