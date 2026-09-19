/**
 * The writers' room. Three stages, kept apart because mixing tools with
 * structured output in one call is awkward, and because a planner that
 * emits the whole running order at once cannot extend indefinitely.
 *
 *   research  (only with --search)  free text gathered from web search
 *   channel   (once per station)    what this channel is
 *   segment   (one call per slot)   what is on next
 *
 * Variety is enforced by construction rather than asked for. Each slot is
 * dealt a card of kind, medium and register before the model sees it, so
 * two segments cannot come out alike however agreeable the model is
 * feeling. Asking for variety in prose does not work: it produced five
 * clips of the same institutional corridor.
 */
import { Array as Arr, Effect, Option, Random, Schema } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModel } from "@effect-uai/core/LanguageModel"
import { turn } from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import type { WebSearch } from "@effect-uai/core/WebSearch"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"
import type { Station } from "./station.js"

/**
 * Anything a planner call can fail with: the provider's errors plus the
 * three ways structured output can come back unusable.
 */
export type PlanError =
  | AiError.AiError
  | StructuredFormat.JsonParseError
  | StructuredFormat.StructuredDecodeError
  | Turn.RefusalRejected

// ---------------------------------------------------------------------------
// Stage 1: research. Only reached with `--search`.
// ---------------------------------------------------------------------------

const RESEARCH_ROUNDS = 4

const RESEARCH_SYSTEM = [
  "You are gathering material for a short television program.",
  "Use the web_search tool to find what is actually happening right now.",
  "Then write a briefing: the specific facts, names, numbers and images a",
  "director could shoot. No preamble and no citations, just the material.",
].join("\n")

const searchKit = Toolkit.describeFailures(
  Toolkit.make(webSearchTool({ maxResults: 5 })),
  AiError.describe,
)

type Round = { readonly history: ReadonlyArray<Items.HistoryItem>; readonly round: number }

/**
 * Search, then write. On the last allowed round the tools are withheld so
 * the model has to produce the briefing rather than searching forever.
 */
const researchRound = (
  state: Round,
  model: string,
): Effect.Effect<string, AiError.AiError, LanguageModel | WebSearch> =>
  Effect.gen(function* () {
    const final = state.round >= RESEARCH_ROUNDS
    const reply = yield* turn({
      model,
      history: state.history,
      ...(final ? {} : { tools: searchKit }),
    })
    const calls = final ? [] : Turn.getToolCalls(reply)
    if (calls.length === 0) return Turn.assistantText(reply)
    const results = yield* Toolkit.collectResults(Toolkit.run(searchKit, calls))
    return yield* researchRound(
      Toolkit.appendToolResults({ ...state, round: state.round + 1 }, reply)(results),
      model,
    )
  })

export const research = (
  brief: string,
  model: string,
): Effect.Effect<string, AiError.AiError, LanguageModel | WebSearch> =>
  researchRound(
    { history: [Items.systemText(RESEARCH_SYSTEM), Items.userText(brief)], round: 0 },
    model,
  )

// ---------------------------------------------------------------------------
// Stage 2: the channel.
// ---------------------------------------------------------------------------

const pickFrom = (options: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.map(Random.nextIntBetween(0, options.length), (i) => options[i] ?? options[0] ?? "")

/**
 * Seeds, not requirements. An LLM asked to invent a TV channel converges
 * on the same handful of ideas; three unrelated cards to react to push
 * each run somewhere else. Kept high-energy on purpose: a vocabulary of
 * "bureaucratic" and "reverent" reliably produces a channel nobody wants
 * to watch.
 */
const TONES = [
  "gleeful",
  "frantic",
  "conspiratorial",
  "unhinged",
  "smug",
  "wounded",
  "evangelical",
  "sarcastic",
  "over-familiar",
  "panicking",
]

const SETTINGS = [
  "a flooded shopping mall",
  "a car boot sale on the moon",
  "the inside of a vending machine",
  "a motorway service station at 3am",
  "an aquarium after closing",
  "the world's last remaining office",
  "a caravan park on the rim of a volcano",
  "a ball pit of indeterminate depth",
  "a cruise ship that never docks",
  "a nine-hole golf course in a cave",
]

const TWISTS = [
  "everyone is an expert in something useless",
  "the laws of physics were renegotiated last week",
  "it is broadcast for an audience of one",
  "the presenters are competing and will not say for what",
  "every advert is for the same product",
  "it has been running for four hundred years",
  "the budget ran out mid-sentence",
  "nobody involved has ever seen television",
  "it is legally required viewing",
  "the channel is trying to sell itself to you",
]

const seeds = Effect.all({
  tone: pickFrom(TONES),
  setting: pickFrom(SETTINGS),
  twist: pickFrom(TWISTS),
})

const Channel = Schema.Struct({
  /** Brainstormed first and committed to second: the variety comes from here. */
  concepts: Schema.Array(Schema.String),
  chosen: Schema.Number,
  channel: Schema.String,
  tagline: Schema.String,
  /** The standby card's image prompt, planned here so Play has only the picture left to make. */
  card: Schema.String,
})

const channelFormat = StructuredFormat.fromEffectSchema(Channel)

export type ChannelPlan = {
  readonly channel: string
  readonly tagline: string
  readonly card: string
}

const INVENT = [
  "Invent a television channel that has never existed.",
  "",
  "A channel, not a show: it runs adverts, idents, news, weather, trailers",
  "and public information films, all sharing one world.",
  "",
  "First brainstorm six concepts that are genuinely different from each other.",
  "Be strange. Absurd premises, invented genres, channels that should not be",
  "allowed to broadcast. Avoid anything that sounds like a streaming service",
  "pitch. Then pick the one you would most want to watch and commit to it.",
].join("\n")

const FOLLOW = [
  "Design a television channel for this brief.",
  "",
  "First brainstorm six angles on it that are genuinely different from each",
  "other, then pick the strongest and commit to it. Serve the brief; the",
  "brainstorm is there to stop you reaching for the obvious framing.",
].join("\n")

export const planChannel = (
  brief: Option.Option<string>,
  briefing: Option.Option<string>,
  model: string,
): Effect.Effect<ChannelPlan, PlanError, LanguageModel> =>
  Effect.gen(function* () {
    const { setting, tone, twist } = yield* seeds
    const idea = yield* pickFrom(CARDS)
    const prompt = [
      Option.match(brief, { onNone: () => INVENT, onSome: () => FOLLOW }),
      ...Option.match(brief, { onNone: () => [], onSome: (b) => ["", `Brief: ${b}`] }),
      ...Option.match(briefing, {
        onNone: () => [],
        onSome: (b) => ["", "Researched material to draw on:", b],
      }),
      "",
      "Seeds to react to, not requirements:",
      `- tone: ${tone}`,
      `- setting: ${setting}`,
      `- twist: ${twist}`,
      "",
      "Write:",
      "- concepts: six one-line pitches",
      "- chosen: the index of the one you picked",
      "- channel: its name",
      "- tagline: one line a continuity announcer would read",
      "- card: one image-generation prompt for the still the channel holds",
      "  between programmes, the way a channel used to hold on a test card.",
      `  Starting point, change it as much as you like: ${idea}. Say what is`,
      "  in frame, how it is arranged and how it is lit; it may carry a few",
      "  words of text such as the channel name. Dry, strange and specific",
      "  beats tasteful. It should reward staring.",
    ].join("\n")

    const reply = yield* turn({
      model,
      structured: channelFormat,
      history: [Items.userText(prompt)],
    })
    const plan = yield* Turn.decodeStructured(reply, channelFormat)
    return { channel: plan.channel, tagline: plan.tagline, card: plan.card }
  })

// ---------------------------------------------------------------------------
// Stage 3: one slot at a time, each dealt its own card.
// ---------------------------------------------------------------------------

/** How much of the running order the planner is shown, so prompts stay bounded. */
const RECENT = 8

const KINDS = [
  "advert",
  "news bulletin",
  "weather",
  "station ident",
  "trailer for a programme that does not exist",
  "nature documentary",
  "cookery segment",
  "sports highlight",
  "infomercial",
  "public information film",
  "children's programming",
  "phone-in",
  "obituary",
  "shopping channel",
  "test card",
  "interview",
  "game show round",
]

/** The look. Without this axis everything comes out photoreal. */
const MEDIUMS = [
  "live action",
  "hand-drawn 2D animation",
  "stop motion with felt and wire",
  "claymation",
  "glossy CGI render",
  "1987 VHS camcorder footage",
  "grainy 16mm film",
  "foam puppets",
  "extreme macro photography",
  "fixed security camera",
  "drone footage",
  "paper cutout animation",
]

const REGISTERS = [
  "absurd",
  "deadpan",
  "sinister",
  "joyful",
  "melodramatic",
  "gloriously incompetent",
  "over-caffeinated",
  "elegiac",
  "smugly corporate",
]

/** The slot a segment must fill, decided before the model is asked. */
export type Card = {
  readonly kind: string
  readonly medium: string
  readonly register: string
}

/**
 * A card whose kind is not one of `avoid`, so the same slot cannot come
 * round twice in a block. Falls back to the full set once nearly
 * everything has aired, which only matters under `--infinite`.
 */
export const deal = (avoid: ReadonlyArray<string>): Effect.Effect<Card> =>
  Effect.gen(function* () {
    const fresh = KINDS.filter((kind) => !avoid.includes(kind))
    return {
      kind: yield* pickFrom(fresh.length > 0 ? fresh : KINDS),
      medium: yield* pickFrom(MEDIUMS),
      register: yield* pickFrom(REGISTERS),
    }
  })

const Segment = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
})

export type Segment = typeof Segment.Type

const segmentFormat = StructuredFormat.fromEffectSchema(Segment)

const recentTitles = (station: Station): string =>
  Arr.isReadonlyArrayEmpty(station.clips)
    ? "(nothing has aired yet)"
    : Arr.takeRight(station.clips, RECENT)
        .map((clip) => `- [${clip.kind ?? "segment"}] ${clip.title}`)
        .join("\n")

/**
 * Two examples rather than a template. The previous version dictated the
 * sentence structure and got the same sentence five times; showing range
 * teaches range.
 */
const EXAMPLES = [
  "Examples of the level of detail and the spread of register:",
  "",
  '"A foam puppet weatherman sweats under studio lights as the magnetic',
  "symbols slide off his map one by one and clatter to the floor. He keeps",
  "presenting. Handheld, pushing in slowly. Sound: his cheerful forecast",
  "continuing over the clattering, plus a laugh track that arrives slightly",
  'too late."',
  "",
  '"Extreme macro on a single sugar cube dissolving in black coffee, shot',
  "like a perfume advert, impossibly slow. Sound: a sincere voice-over about",
  "courage, swelling strings, and at the very end a phone number read too",
  'fast to catch."',
]

/**
 * One segment for one card. Called once per slot rather than in batches:
 * a batch shares one generation's mood, which is how five items end up
 * looking like one item.
 */
export const planSegment = (
  station: Station,
  card: Card,
  model: string,
): Effect.Effect<Segment, PlanError, LanguageModel> =>
  Effect.gen(function* () {
    const prompt = [
      `You are programming "${station.channel}" (${station.tagline}).`,
      ...Option.match(Option.fromNullishOr(station.brief), {
        onNone: () => [],
        onSome: (b) => ["", `Brief: ${b}`],
      }),
      "",
      "Recently aired, do not repeat or continue any of it:",
      recentTitles(station),
      "",
      "Write the next slot. It is:",
      `- kind: ${card.kind}`,
      `- medium: ${card.medium}`,
      `- register: ${card.register}`,
      "",
      "This is a self-contained item in a broadcast day, not a scene in a",
      "story. It shares no characters, location or continuity with anything",
      "above. It should be funny, unsettling or genuinely surprising; a",
      "competent, tasteful shot is a failure.",
      "",
      ...EXAMPLES,
      "",
      "Write:",
      "- title: what the listings would call it",
      `- prompt: one continuous ${station.clipSeconds} second shot for a`,
      "  text-to-video model. Say what is in frame, what moves, how the camera",
      "  behaves, and how it is lit, in the medium named above. End with a",
      '  sentence beginning "Sound:" describing what is heard: voice-over,',
      "  dialogue, music, a jingle, diegetic noise or near silence. The model",
      "  generates audio, so the sound carries as much of the joke as the",
      "  picture. No cuts and no on-screen text.",
    ].join("\n")

    const reply = yield* turn({
      model,
      structured: segmentFormat,
      history: [Items.userText(prompt)],
    })
    return yield* Turn.decodeStructured(reply, segmentFormat)
  })

// ---------------------------------------------------------------------------
// The standby card
// ---------------------------------------------------------------------------

/**
 * Starting points for the card held while the next programme renders. A
 * still, so it needs no loop and no sound, but it still has to be worth
 * looking at: a card nobody enjoys is worse than the wait it covers.
 */
const CARDS = [
  "an 80s colour calibration card with something wrong in one corner",
  "a test pattern assembled from the channel's own merchandise",
  "a fish tank screensaver where one fish is clearly not a fish",
  "a hand-painted sign apologising for an unspecified incident",
  "a clock face whose hands disagree with each other",
  "a plastic model of the channel's headquarters on a turntable",
  "an arrangement of office supplies photographed like a still life",
  "a knitted version of the channel logo, slightly misshapen",
  "a departures board listing programmes instead of destinations",
  "a bowl of fruit lit like a hostage photograph",
]

const Standby = Schema.Struct({ prompt: Schema.String })

const standbyFormat = StructuredFormat.fromEffectSchema(Standby)

/** One image prompt for the channel's standby card, for a manifest planned before the card was. */
export const planStandby = (
  station: Station,
  model: string,
): Effect.Effect<string, PlanError, LanguageModel> =>
  Effect.gen(function* () {
    const idea = yield* pickFrom(CARDS)
    const prompt = [
      `You are designing the standby card for "${station.channel}" (${station.tagline}).`,
      "",
      "It is held on screen between programmes, the way a channel used to",
      "hold on a test card. One still image, 16:9, no motion.",
      "",
      `Starting point, change it as much as you like: ${idea}.`,
      "",
      "Dry, strange and specific beats tasteful. It should reward staring.",
      "",
      "Write:",
      "- prompt: one image-generation prompt. Say what is in frame, how it is",
      "  arranged, and how it is lit. It may carry a few words of text such as",
      "  the channel name or an apology, described as part of the picture.",
    ].join("\n")

    const reply = yield* turn({
      model,
      structured: standbyFormat,
      history: [Items.userText(prompt)],
    })
    return yield* Effect.map(Turn.decodeStructured(reply, standbyFormat), (s) => s.prompt)
  })
