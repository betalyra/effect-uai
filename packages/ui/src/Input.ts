/**
 * What a client sends to start or continue a run. The library only needs an
 * `id` on an input (generated on the client, so optimistic UI can match it
 * to `run-started { inputs }`); this module is a preset, and an app with a
 * different shape passes its own schema.
 *
 * A `submit` carries user `messages` (core items, entering the loop's
 * history unchanged) and, with `make(DataSchema)`, typed `data` the server
 * interprets (template id, model choice). Decode request bodies with the
 * `*Json` codecs: they carry image bytes over JSON.
 *
 * Constructors build drafts without randomness; the id is assigned where an
 * input is sent (`Atoms.submit`, or `withId`).
 */
import * as Items from "@effect-uai/core/Items"
import { Effect, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { InputId } from "./RunEvent.js"

/** A user message: core's `message` item with role `user` and input blocks only. */
export const UserMessage = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("user"),
  content: Schema.Array(Schema.Union([Items.InputText, Items.InputImage])),
})
export type UserMessage = typeof UserMessage.Type
export type Content = UserMessage["content"][number]

/** The answer to one `run-interrupted` interrupt. */
export const Decision = Schema.Struct({
  callId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String),
})
export type Decision = typeof Decision.Type

const submitFields = {
  id: InputId,
  kind: Schema.Literal("submit"),
  messages: Schema.Array(UserMessage),
}

const resolveFields = {
  id: InputId,
  kind: Schema.Literal("resolve"),
  decisions: Schema.Array(Decision),
}

export const Submit = Schema.Struct(submitFields)
export type Submit = typeof Submit.Type

export const Resolve = Schema.Struct(resolveFields)
export type Resolve = typeof Resolve.Type

export const Input = Schema.Union([Submit, Resolve])
export type Input = typeof Input.Type

export const SubmitJson = Schema.toCodecJson(Submit)
export const InputJson = Schema.toCodecJson(Input)

/**
 * The preset with typed app `data`: required on `submit`, optional on
 * `resolve`.
 */
export const make = <D extends Schema.Top>(data: D) => {
  const Submit = Schema.Struct({ ...submitFields, data })
  const Resolve = Schema.Struct({ ...resolveFields, data: Schema.optionalKey(data) })
  const Input = Schema.Union([Submit, Resolve])
  return {
    Submit,
    Resolve,
    Input,
    SubmitJson: Schema.toCodecJson(Submit),
    InputJson: Schema.toCodecJson(Input),
  }
}

/** An input whose `id` is not assigned yet (per union member). */
export type Draft<I> = I extends unknown ? Omit<I, "id"> & { readonly id?: InputId } : never

/** A draft with its `id` assigned. */
export type Identified<D> = D & { readonly id: InputId }

/** What a transport receives for inputs of type `I`: the draft `submit` took, with its id. */
export type Sent<I = Input> = Identified<Draft<I>>

/** Assign a UUIDv7 id unless the draft already has one. */
export const withId = <D extends { readonly id?: InputId }>(
  draft: D,
): Effect.Effect<Identified<D>, never, SecureRandom.SecureRandom> => {
  const { id } = draft
  return id !== undefined
    ? Effect.succeed({ ...draft, id })
    : SecureRandom.SecureRandom.use((random) => random.uuidV7()).pipe(
        Effect.map((uuid) => ({ ...draft, id: InputId.make(uuid) })),
      )
}

/** A user message: `text` first, then any attachments (images). */
export const user = (text: string, attachments: ReadonlyArray<Content> = []): UserMessage => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }, ...attachments],
})

type Id = { readonly id?: InputId }

const toMessages = (messages: string | ReadonlyArray<UserMessage>): ReadonlyArray<UserMessage> =>
  typeof messages === "string" ? [user(messages)] : messages

export function submit(messages: string | ReadonlyArray<UserMessage>, options?: Id): Draft<Submit>
export function submit<D>(
  messages: string | ReadonlyArray<UserMessage>,
  options: Id & { readonly data: D },
): Draft<Submit> & { readonly data: D }
export function submit(
  messages: string | ReadonlyArray<UserMessage>,
  options?: Id & { readonly data?: unknown },
): Draft<Submit> & { readonly data?: unknown } {
  return {
    ...options,
    kind: "submit",
    messages: toMessages(messages),
  }
}

export function resolve(decisions: ReadonlyArray<Decision>, options?: Id): Draft<Resolve>
export function resolve<D>(
  decisions: ReadonlyArray<Decision>,
  options: Id & { readonly data: D },
): Draft<Resolve> & { readonly data: D }
export function resolve(
  decisions: ReadonlyArray<Decision>,
  options?: Id & { readonly data?: unknown },
): Draft<Resolve> & { readonly data?: unknown } {
  return { ...options, kind: "resolve", decisions }
}

/** The submit's messages as model history; no translation needed. */
export const toHistory = (input: Pick<Submit, "messages">): ReadonlyArray<Items.Message> =>
  input.messages

/** All text of the submit's messages, joined by blank lines. */
export const text = (input: Pick<Submit, "messages">): string =>
  input.messages
    .flatMap((m) => m.content.flatMap((block) => (block.type === "input_text" ? [block.text] : [])))
    .join("\n\n")
