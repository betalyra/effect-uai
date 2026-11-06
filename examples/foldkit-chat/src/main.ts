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
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Effect, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { type HttpClient, HttpClientRequest } from "effect/http"
import { Command, type Runtime, Subscription, type Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { type ChatPayloads, ChatUi } from "./chat-ui.ts"

// TRANSPORT: one request per message (server.ts)

const ChatBody = Schema.Struct({
  chatId: Schema.optionalKey(StreamId),
  input: Input.SubmitJson,
})

const transport = Transport.direct({
  // No chat id yet: the server starts a chat and names it on its first answer.
  request: (input: Input.Submit, chatId: StreamId | null) =>
    HttpClientRequest.post("/api/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(chatId === null ? { input } : { chatId, input }),
    ),
})

// The `Thread` fold, typed by the contract.
const fold = Thread.presetFor<ChatPayloads>()

// MODEL

const Request = Schema.Struct({
  input: Input.Submit,
  chatId: Schema.NullOr(StreamId),
})

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
  CreatedInput: { input: Input.Submit },
  ClickedStop: {},
  GotEnvelope: { envelope: ChatUi.Envelope },
  EndedRequest: {},
})
export type Message = typeof Message.Type

// COMMANDS

// The input id is random, so it comes from a Command; `update` stays pure.
const CreateInput = Command.define("CreateInput", {
  args: { text: Schema.String },
  messages: [Message.CreatedInput],
  execute: ({ text }) =>
    Input.withId(Input.submit(text)).pipe(
      Effect.map((input) => Message.CreatedInput({ input })),
      Effect.provide(SecureRandom.layerWebCrypto),
    ),
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
      return {
        model: { ...model, prompt: "" },
        commands: [CreateInput({ text })],
      }
    },
    // Optimistic: the message shows before the server answers.
    CreatedInput: ({ input }) => ({
      model: {
        ...model,
        thread: fold.submitted(model.thread, input),
        request: { input, chatId: model.thread.streamId },
      },
    }),
    // Clearing the request ends its Subscription, which aborts the fetch.
    ClickedStop: () => ({
      model: {
        ...model,
        thread: fold.ended(model.thread, "stopped"),
        request: null,
      },
    }),
    GotEnvelope: ({ envelope }) => ({
      model: { ...model, thread: fold.step(model.thread, envelope) },
    }),
    // Without its terminal (a failed request), the run settles as disconnected.
    EndedRequest: () => ({
      model: {
        ...model,
        thread: fold.ended(model.thread, "disconnected"),
        request: null,
      },
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
                Stream.catchCause(() => Stream.empty),
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

const bubble = (
  h: HtmlBuilder<Message>,
  role: "user" | "assistant",
  text: string,
  notes: ReadonlyArray<string> = [],
): Html => h.div([h.Class(role)], [text, ...notes.map((n) => h.small([], [n]))])

const assistant = (h: HtmlBuilder<Message>, run: Run, live: boolean): Html => {
  const tools = run.blocks.flatMap(toolLine)
  const text = answer(run)
  if (!live) return bubble(h, "assistant", text, [...tools, ...notes(run)])
  return text === ""
    ? bubble(h, "assistant", "…", [...tools, "thinking"])
    : bubble(h, "assistant", text, [...tools, "streaming"])
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const { thread } = model
  const settled = thread.messages.map((m) =>
    m.role === "user" ? bubble(h, "user", Input.text(m.value)) : assistant(h, m.value, false),
  )
  const active = thread.active === null ? [] : [assistant(h, thread.active, true)]
  const busy = model.request !== null
  return {
    title: "effect-uai · FoldKit chat",
    body: h.main(
      [],
      [
        h.h1([], ["FoldKit chat"]),
        h.div([h.Id("log")], [...settled, ...active]),
        h.form(
          [h.OnSubmit(Message.SubmittedPrompt())],
          [
            h.input([
              h.Value(model.prompt),
              h.Placeholder("Ask about the weather, or today's date"),
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
