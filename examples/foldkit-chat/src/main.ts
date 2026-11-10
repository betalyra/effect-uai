/**
 * A chat in FoldKit over `@effect-uai/ui`. The chat is `Thread` state inside
 * the Model and the `Thread` fold runs inside `update`. The open request is a
 * Subscription keyed on the input in flight: setting it sends, clearing it
 * stops (FoldKit tears the stream down, which aborts the request). No atoms:
 * FoldKit owns the state, `@effect-uai/ui` supplies the fold and the transport.
 *
 * Envelopes are decoded with the shared `ChatUi` contract on arrival, so the
 * thread is typed: a tool block narrowed by name has its tool's output.
 */
import * as ToolDecision from "@effect-uai/core/ToolDecision"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Array as Arr, Effect, Match, Option, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { type HttpClient, HttpClientRequest } from "effect/http"
import { Command, type Runtime, Subscription, type Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { type ChatPayloads, ChatUi, type FindRestaurants } from "./chat-ui.ts"

// TRANSPORT: one request per input (server.ts)

// A message (`Input.submit`) or a verdict on a waiting call (`Input.resolve`).
const ChatBody = Schema.Struct({
  chatId: Schema.optionalKey(StreamId),
  input: Input.InputJson,
})

const transport = Transport.direct({
  // No chat id yet: the server starts a chat and names it on its first answer.
  request: (input: Input.Input, chatId: StreamId | null) =>
    HttpClientRequest.post("/api/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(chatId === null ? { input } : { chatId, input }),
    ),
})

// The `Thread` fold, typed by the contract.
const fold = Thread.presetFor<ChatPayloads>()

// MODEL

const Request = Schema.Struct({ input: Input.Input, chatId: Schema.NullOr(StreamId) })

export const Model = Schema.Struct({
  prompt: Schema.String,
  thread: ChatUi.Thread,
  /** The request in flight; its Subscription streams the answer. */
  request: Schema.NullOr(Request),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedPrompt: { prompt: Schema.String },
  SubmittedPrompt: {},
  /** Approve or Deny on a call that waits for the user. */
  ClickedVerdict: { callId: Schema.String, decision: ToolDecision.Default.schema },
  CreatedInput: { input: Input.Input },
  ClickedStop: {},
  GotEnvelope: { envelope: ChatUi.Envelope },
  EndedRequest: {},
})
export type Message = typeof Message.Type

// COMMANDS: input ids are random, so they come from Commands; `update` stays pure.

const withId = (draft: Input.Draft<Input.Input>) =>
  Input.withId(draft).pipe(
    Effect.map((input) => Message.CreatedInput({ input })),
    Effect.provide(SecureRandom.layerWebCrypto),
  )

const CreateMessage = Command.define("CreateMessage", {
  args: { text: Schema.String },
  messages: [Message.CreatedInput],
  execute: ({ text }) => withId(Input.submit(text)),
})

// The page only votes; the server checks the call is waiting, and decides.
const CreateVerdict = Command.define("CreateVerdict", {
  args: { callId: Schema.String, decision: ToolDecision.Default.schema },
  messages: [Message.CreatedInput],
  execute: ({ callId, decision }) => withId(Input.resolve([{ callId, decision }])),
})

// UPDATE

type Return = Update.Return<Model, Message>

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ChangedPrompt: ({ prompt }) => ({ model: { ...model, prompt } }),
    SubmittedPrompt: () => {
      const text = model.prompt.trim()
      // One run at a time: the next message waits for this answer.
      if (text === "" || model.request !== null) return { model }
      return { model: { ...model, prompt: "" }, commands: [CreateMessage({ text })] }
    },
    ClickedVerdict: ({ callId, decision }) =>
      model.request !== null
        ? { model }
        : { model, commands: [CreateVerdict({ callId, decision })] },
    // Optimistic: a message shows before the server answers.
    CreatedInput: ({ input }) => ({
      model: {
        ...model,
        thread: fold.submitted(model.thread, input),
        request: { input, chatId: model.thread.streamId },
      },
    }),
    // Clearing the request ends its Subscription, which aborts the fetch.
    ClickedStop: () => ({
      model: { ...model, thread: fold.ended(model.thread, "stopped"), request: null },
    }),
    GotEnvelope: ({ envelope }) => ({
      model: { ...model, thread: fold.step(model.thread, envelope) },
    }),
    // Without its terminal (a failed request), the run settles as disconnected.
    EndedRequest: () => ({
      model: { ...model, thread: fold.ended(model.thread, "disconnected"), request: null },
    }),
  })

// SUBSCRIPTIONS: the answer to the request in flight, decoded by the contract

export const subscriptions = Subscription.make<Model, Message, HttpClient.HttpClient>()(
  (entry) => ({
    answer: entry(
      { request: Schema.NullOr(Request) },
      {
        modelToDependencies: (model) => ({ request: model.request }),
        dependenciesToStream: ({ request }) =>
          request === null
            ? Stream.empty
            : transport.start(request.input, request.chatId).pipe(
                Stream.mapEffect(ChatUi.decode),
                Stream.map((envelope) => Message.GotEnvelope({ envelope })),
                // The request ends either way; log why, then `EndedRequest` settles it.
                Stream.catchCause((cause) =>
                  Stream.fromEffect(Effect.logError(cause)).pipe(Stream.drain),
                ),
                Stream.concat(Stream.make(Message.EndedRequest())),
              ),
      },
    ),
  }),
)

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { prompt: "", thread: fold.initial, request: null },
})

// VIEW

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

const toolCard = (h: HtmlBuilder<Message>, block: ToolBlock): Html =>
  h.div(
    [h.Class("tool")],
    [
      h.span([], [toolSummary(block)]),
      ...(block.status === "awaiting-approval"
        ? [
            h.button(
              [
                h.Type("button"),
                h.OnClick(
                  Message.ClickedVerdict({
                    callId: block.id,
                    decision: ToolDecision.Default.Approve(),
                  }),
                ),
              ],
              ["Approve"],
            ),
            h.button(
              [
                h.Type("button"),
                h.OnClick(
                  Message.ClickedVerdict({
                    callId: block.id,
                    decision: ToolDecision.Default.Deny(),
                  }),
                ),
              ],
              ["Deny"],
            ),
          ]
        : []),
    ],
  )

const liveNote = (text: string) => (text === "" ? "thinking" : "streaming")

// Live metrics (the contract's `live` values) while it streams; token usage once known.
const stats = (run: Run): ReadonlyArray<Option.Option<string>> => [
  Option.map(Option.fromNullishOr(run.live.ttftMs), (ms) => `TTFT ${ms} ms`),
  Option.map(Option.fromNullishOr(run.live.tokensPerSecond), (rate) => `${rate} tok/s`),
  Option.map(
    Option.fromNullishOr(run.usage?.output_tokens),
    (out) => `${run.usage?.input_tokens ?? "?"} in / ${out} out tokens`,
  ),
]

const assistant = (h: HtmlBuilder<Message>, run: Run, live: boolean): Html => {
  const text = answer(run)
  const note = live ? Option.some(liveNote(text)) : runNote(run)
  const line = Arr.getSomes([note, ...stats(run)]).join(" · ")
  return h.div(
    [h.Class("assistant")],
    [
      text === "" && live ? "…" : text,
      ...run.blocks.flatMap((b) => (b.type === "tool" ? [toolCard(h, b)] : [])),
      ...(line === "" ? [] : [h.small([], [line])]),
    ],
  )
}

// A verdict has no text; only messages show as bubbles.
const userBubble = (h: HtmlBuilder<Message>, value: Thread.UserContent): ReadonlyArray<Html> =>
  Input.text(value) === "" ? [] : [h.div([h.Class("user")], [Input.text(value)])]

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const { thread } = model
  const settled = thread.messages.flatMap((m) =>
    m.role === "user" ? userBubble(h, m.value) : [assistant(h, m.value, false)],
  )
  const active = thread.active === null ? [] : [assistant(h, thread.active, true)]
  const busy = model.request !== null
  return {
    title: "effect-uai · FoldKit chat",
    body: h.main(
      [],
      [
        h.h1([], ["FoldKit chat"]),
        h.div([h.Id("log")], [h.div([], [...settled, ...active])]),
        h.form(
          [h.OnSubmit(Message.SubmittedPrompt())],
          [
            h.input([
              h.Value(model.prompt),
              h.Placeholder("Ask about the weather, or to send an email or book a table"),
              h.Autofocus(true),
              h.OnInput((prompt) => Message.ChangedPrompt({ prompt })),
            ]),
            h.button([h.Type("submit"), h.Disabled(busy)], ["Send"]),
            h.button(
              [h.Type("button"), h.Disabled(!busy), h.OnClick(Message.ClickedStop())],
              ["Stop"],
            ),
          ],
        ),
      ],
    ),
  }
}
