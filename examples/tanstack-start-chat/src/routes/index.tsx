import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as ToolDecision from "@effect-uai/core/ToolDecision"
import * as Input from "@effect-uai/ui/Input"
import * as RunView from "@effect-uai/ui/RunView"
import type * as Thread from "@effect-uai/ui/Thread"
import { createFileRoute } from "@tanstack/react-router"
import { Array as Arr, Match, Option } from "effect"
import { useState } from "react"
import { Streamdown } from "streamdown"
import { chat } from "../chat"
import type { ChatPayloads, FindRestaurants } from "../chat-ui"

export const Route = createFileRoute("/")({ component: Chat })

type Run = RunView.RunView<ChatPayloads>
type ToolBlock = Extract<RunView.Block<ChatPayloads>, { type: "tool" }>
type Failure = ChatPayloads["tool"]["failure"]

// The answer, or the refusal when the model declined.
const answer = (run: Run) => RunView.text(run) || (RunView.refusal(run) ?? "")

const runNote = (run: Run): Option.Option<string> =>
  Match.value(run).pipe(
    Match.when({ status: "stopped" }, () => Option.some("stopped")),
    Match.when({ status: "failed" }, (r) => Option.some(`failed: ${r.error?.reason}`)),
    Match.orElse(() => Option.none()),
  )

// A failed call carries a typed error: the tool's own, core's, or the app's closing.
const failure = (error: Failure): string =>
  Match.value(error).pipe(
    Match.tag("Denied", () => "you declined"),
    Match.tag("Superseded", () => "skipped: you asked something else"),
    Match.tag("CityNotFound", (e) => `no city called ${e.city}`),
    Match.tag("UnknownTimezone", (e) => `unknown timezone ${e.timezone}`),
    Match.orElse((e) => `failed: ${e.message}`),
  )

const restaurants = (found: typeof FindRestaurants.outputSchema.Type, note = "") =>
  `restaurants in ${found.city}${note}: ${found.restaurants.map((r) => `${r.name} (${r.area}, ${r.rating}★)`).join(", ")}`

// Each pattern narrows the block: by `name` to its tool's types (`observedAt`,
// `now`, `sentAt` are Dates), by `outcome` to a value or an error, and
// `input: Match.defined` once the model has sent the arguments.
const toolSummary = Match.type<ToolBlock>().pipe(
  Match.when({ outcome: { _tag: "Failure" } }, (b) => `${b.name}: ${failure(b.outcome.error)}`),
  Match.when(
    { name: "get_weather", outcome: { _tag: "Success" } },
    ({ outcome: { value: w } }) =>
      `${w.city}, ${w.country}: ${w.temperatureC}°C, wind ${w.windSpeedKmh} km/h (${w.observedAt.toLocaleTimeString()})`,
  ),
  Match.when(
    { name: "get_date", outcome: { _tag: "Success" } },
    ({ outcome: { value: d } }) =>
      `${d.now.toLocaleString(undefined, { timeZone: d.timezone })} (${d.timezone})`,
  ),
  // While it streams, `partial` is the list so far; then the outcome.
  Match.when({ name: "find_restaurants", outcome: { _tag: "Success" } }, ({ outcome }) =>
    restaurants(outcome.value),
  ),
  Match.when({ name: "find_restaurants", partial: Match.defined }, ({ partial }) =>
    restaurants(partial, " (searching…)"),
  ),
  Match.when(
    { name: "send_email", input: Match.defined, outcome: { _tag: "Success" } },
    ({ input, outcome }) =>
      `email sent to ${input.to} at ${outcome.value.sentAt.toLocaleTimeString()}`,
  ),
  Match.when(
    { name: "send_email", input: Match.defined },
    ({ input }) => `email to ${input.to}: "${input.subject}"`,
  ),
  Match.when(
    { name: "book_table", input: Match.defined, outcome: { _tag: "Success" } },
    ({ input }) => `${input.restaurant}, ${input.time}, ${input.guests} guests: booked`,
  ),
  Match.when(
    { name: "book_table", input: Match.defined },
    ({ input }) => `${input.restaurant}, ${input.time}, ${input.guests} guests`,
  ),
  Match.orElse((b) => `${b.name}: ${b.status}`),
)

function ToolCard(props: { block: ToolBlock }) {
  const submit = useAtomSet(chat.submit)
  const { block } = props
  // The page only votes; the server checks the call is waiting, and decides.
  const vote = (approved: boolean) =>
    submit(
      Input.resolve([
        {
          callId: block.id,
          decision: approved ? ToolDecision.Default.Approve() : ToolDecision.Default.Deny(),
        },
      ]),
    )
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
const stats = (run: Run): ReadonlyArray<Option.Option<string>> => [
  Option.map(Option.fromNullishOr(run.live.ttftMs), (ms) => `TTFT ${ms} ms`),
  Option.map(Option.fromNullishOr(run.live.tokensPerSecond), (rate) => `${rate} tok/s`),
  Option.map(
    Option.fromNullishOr(run.usage?.output_tokens),
    (out) => `${run.usage?.input_tokens ?? "?"} in / ${out} out tokens`,
  ),
]

function Assistant(props: { run: Run; live: boolean }) {
  const text = answer(props.run)
  const note = props.live ? Option.some(liveNote(text)) : runNote(props.run)
  const line = Arr.getSomes([note, ...stats(props.run)]).join(" · ")
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

function Chat() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  const stop = useAtomSet(chat.stop)
  const [prompt, setPrompt] = useState("")
  const busy = thread.active !== null

  return (
    <main>
      <h1>TanStack Start chat</h1>
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
