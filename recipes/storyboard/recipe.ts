/**
 * A comic that looks like one comic. The style block, restated on every
 * prompt, holds the medium; the sheets and the scene, attached as images,
 * hold identity and place, which text cannot: image models keep no state,
 * so "a girl in a red hat" is re-imagined every panel.
 *
 *   cast → direct → stage    barriers; cast and stage run concurrently
 *   then panel by panel, in order: render → critique → redo, up to `rounds`
 *
 * Panels are sequential because each is drawn with the one before it
 * attached, which is what makes the board a sequence. Chaining on that
 * alone would compound drift; chaining while the fixed anchors stay
 * attached does not (arxiv 2606.11751, 2506.10941).
 *
 * `board` is a `Stream`, so every sheet, scene, panel and rejected take
 * lands as it happens rather than all at the end.
 *
 * Runtime-agnostic: generic `ImageGenerator` and `LanguageModel` tags only.
 */
import { Array as Arr, Clock, Data, Effect, Option, Ref, Result, Schema, Stream } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { ImageResolution, ImageSource } from "@effect-uai/core/Image"
import { edit, generate, type ImageGenerator } from "@effect-uai/core/ImageGenerator"
import * as Items from "@effect-uai/core/Items"
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

/**
 * Two LLM stages decode structured output, so the board's failures include
 * the decode ones alongside the provider's.
 */
export type BoardError =
  | AiError.AiError
  | Turn.RefusalRejected
  | StructuredFormat.JsonParseError
  | StructuredFormat.StructuredDecodeError

export type Sheet = {
  /** Referenced by the director's shot specs. */
  readonly id: string
  readonly description: string
}

export type Beat = {
  readonly page: number
  readonly shot: string
}

export type BoardConfig = {
  readonly style: string
  readonly sheets: ReadonlyArray<Sheet>
  readonly beats: ReadonlyArray<Beat>
  readonly imageModel: string
  readonly llmModel: string
  /** Panel shape is the director's, per shot. This is the tier both stages use. */
  readonly resolution?: ImageResolution
  /** Bounds the cast and stage stages. Panels are always sequential. */
  readonly concurrency?: number
  /** Re-render rounds after the first. Default 1. */
  readonly rounds?: number
}

export type Panel = {
  readonly index: number
  readonly page: number
  readonly image: ImageSource
  /** Sheet ids the director attached. */
  readonly sheets: ReadonlyArray<string>
  /** The critic's note when it rejected the panel, absent once it passes. */
  readonly rejected?: string
}

/** Wall clock per call, so a slow run says which stage is slow. */
const timed = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<readonly [A, number], E, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const value = yield* self
    return [value, (yield* Clock.currentTimeMillis) - start] as const
  })

// ---------------------------------------------------------------------------
// Stage 1: cast
// ---------------------------------------------------------------------------

/** Neutral and plain-backgrounded: a sheet is a reference, not a shot. */
const sheetOf = (
  cfg: BoardConfig,
  sheet: Sheet,
): Effect.Effect<readonly [string, ImageSource], AiError.AiError, ImageGenerator> =>
  Effect.map(
    generate({
      prompt: `${cfg.style}\n${sheet.description}`,
      model: cfg.imageModel,
      aspectRatio: "1:1",
      ...(cfg.resolution !== undefined && { resolution: cfg.resolution }),
    }),
    (response) => [sheet.id, response.images[0]!.image] as const,
  )

// ---------------------------------------------------------------------------
// Stage 2: direct
// ---------------------------------------------------------------------------

/**
 * A closed set, not a free ratio: the endpoint rejects extreme shapes, and a
 * page of arbitrary rectangles stops reading as a page. At a fixed tier the
 * short edge is pinned, so `1:1` is also the cheapest of the three.
 */
const PanelAspect = Schema.Literals(["3:2", "1:1", "2:3"])

/**
 * A place in a particular state: the roof at dusk and the roof at night in
 * rain are two scenes, one location sheet. Rendered once into an anchor
 * image that every panel in it is drawn from, so panels sharing a scene
 * share a geography instead of each inventing one.
 */
const SceneSpec = Schema.Struct({
  id: Schema.String,
  /** The establishing shot for the place: light, weather, camera. No people. */
  description: Schema.String,
  /** Location sheet ids this scene is built from. */
  sheets: Schema.Array(Schema.String),
})
export type SceneSpec = typeof SceneSpec.Type

const ShotSpec = Schema.Struct({
  panel: Schema.Number,
  /** What to draw. Camera, action, place. Never appearance. */
  prompt: Schema.String,
  /** Character and prop sheet ids this shot needs. The scene carries the place. */
  sheets: Schema.Array(Schema.String),
  /** Panel shape, chosen per shot. */
  aspect: PanelAspect,
  /** Which scene this panel happens in. */
  scene: Schema.String,
})
export type ShotSpec = typeof ShotSpec.Type

const ShotList = Schema.Struct({
  scenes: Schema.Array(SceneSpec),
  shots: Schema.Array(ShotSpec),
})
export type ShotList = typeof ShotList.Type
const shotListFormat: StructuredFormat.StructuredFormat<ShotList> =
  StructuredFormat.fromEffectSchema(ShotList)

const DIRECTOR = [
  "You are directing a comic. Break the beats into scenes, then write the",
  "drawing prompt for each panel and list the sheets the artist needs.",
  "",
  "The artist draws every panel from scratch, alone, having never seen the",
  "other panels. It knows only your shot text and the images you attach. Every",
  "sheet is drawn at the same size on its own blank square, so the sheets say",
  "what things are made of and nothing about how big they are.",
  "",
  "Scenes:",
  "- A scene is a place in one particular state. The same rooftop at dusk and",
  "  at night in the rain is two scenes. Walking indoors is a new scene.",
  "- Consecutive beats that share a place and a state share a scene id.",
  "- `description` is an establishing shot of the empty place: light, weather,",
  "  time of day, camera, what has changed since the last time we were here.",
  "  Never any people or moving props: it is the stage, not the action.",
  "- Attach the location sheets the place is built from. If the story has no",
  "  sheet for it, describe it and attach nothing.",
  "- Each scene is drawn once and handed to every panel in it, so those panels",
  "  share one geography instead of inventing one apiece. Spend the words.",
  "",
  "Rules:",
  "- Never describe what a character or prop looks like. The sheets carry that,",
  "  and repeating it in words invites the model to invent a different version.",
  "- Size is the exception, because the sheets cannot carry it. Whenever two",
  "  or more sheets share a panel, say how big they are against each other in",
  "  plain terms: knee-high to her, small enough to sit in one hand, tall",
  "  enough to block the doorway. Leave it out and a mug comes out the size of",
  "  a head, or a character changes height between panels.",
  "- Write camera, action, staging, light and mood only.",
  "- Draw the event, not the aftermath. When a beat is something happening,",
  "  something breaking, falling, being torn away, arriving, the panel catches",
  "  it mid-happening: the thing still in the air, the hand closing on nothing.",
  "  A shot of someone reacting leaves the reader guessing what they reacted",
  "  to, and the story loses the moment it was built on.",
  "- Give a change of mind a body. Deciding, noticing, giving up, relenting:",
  "  none of them have an appearance. When a beat turns on one, make it",
  "  physical, a distance that closes, a posture that drops, a light that",
  "  changes colour, something let go of. Draw the evidence, never the state.",
  "- No two consecutive panels may be the same picture. When neighbouring",
  "  beats share a place and a cast, change the camera: closer, further, or",
  "  from somewhere else. Two wide shots of the same subject in a row read as",
  "  one beat drawn twice, and the second one is wasted.",
  "- Carry the state forward. Anything an earlier beat established that is still",
  "  true has to be restated in every later shot: something a character now",
  "  carries, wears or has had attached to them, the time of day, the weather,",
  "  a door left open. Name a recurring object the same way every time, so it",
  "  is the same object and not a new one.",
  "- A shot lists character and prop sheets only. Its scene already carries",
  "  the place, so never attach a location sheet to a shot.",
  "- Attach the sheet for everyone and everything the shot names. A character",
  "  named in the text without their sheet attached gets invented, in the",
  "  wrong clothes, and the reader sees a stranger.",
  "- Attach nothing else. A close-up of hands does not need the cat.",
  "- Say who is not there. An empty frame invites the artist to invent a",
  "  protagonist for it, in the wrong clothes, since it has no sheet to work",
  "  from. Whenever a character the reader has been following is off-panel,",
  "  write it: `no people in this panel`, `Nix is not in this shot`.",
  "- At most three sheets per shot: pick the ones the reader's eye lands on.",
  "  Every reference is an upload and a slower render.",
  "- Choose the panel shape from the shot: `3:2` for a wide establishing or",
  "  two-shot, `2:3` for a standing figure or a fall, `1:1` for a close-up or",
  "  a beat. Vary it. A page of identical rectangles reads as a storyboard.",
  "- Return exactly one shot per beat, in order, `panel` counting from 1.",
].join("\n")

const brief = (cfg: BoardConfig): string =>
  [
    "Sheets:",
    ...Arr.map(cfg.sheets, (s) => `- ${s.id}: ${s.description}`),
    "",
    "Beats:",
    ...Arr.map(cfg.beats, (b, i) => `${i + 1}. (page ${b.page}) ${b.shot}`),
  ].join("\n")

/** One structured answer: fold the event stream to its terminal turn, decode. */
const ask = <A>(
  history: ReadonlyArray<Items.HistoryItem>,
  model: string,
  format: StructuredFormat.StructuredFormat<A>,
): Effect.Effect<A, BoardError, LanguageModel> =>
  streamTurn({ history, model, structured: format }).pipe(
    Stream.filterMap((e) => (Turn.isTurnComplete(e) ? Result.succeed(e.turn) : Result.failVoid)),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onSome: (turn: Turn.Turn): Effect.Effect<A, BoardError> =>
          Turn.decodeStructured(turn, format),
        onNone: (): Effect.Effect<A, BoardError> => Effect.fail(new AiError.IncompleteTurn({})),
      }),
    ),
  )

/**
 * One call for the whole board, so the director sees every beat at once
 * and the panels stay independent. Selecting sheets rather than sending
 * all of them matters as the cast grows: providers cap references per call
 * (16 on OpenAI, 14 on Gemini).
 */
export const direct = (cfg: BoardConfig): Effect.Effect<ShotList, BoardError, LanguageModel> =>
  ask([Items.systemText(DIRECTOR), Items.userText(brief(cfg))], cfg.llmModel, shotListFormat)

// ---------------------------------------------------------------------------
// Stage 3: stage
// ---------------------------------------------------------------------------

const sheetsFor = (
  sheets: Record<string, ImageSource>,
  ids: ReadonlyArray<string>,
): ReadonlyArray<ImageSource> =>
  // An id the director invented is dropped rather than failing the panel.
  Arr.flatMap(ids, (id) => (sheets[id] === undefined ? [] : [sheets[id]]))

/**
 * One establishing image per scene, drawn from the location sheets. Every
 * panel in the scene is then drawn from it, so they share a rooftop rather
 * than each inventing one from the same neutral sheet. Still one hop from
 * a fixed source: nothing is chained to the panel before it, so nothing
 * accumulates.
 */
export const stage = (
  cfg: BoardConfig,
  sheets: Record<string, ImageSource>,
  scene: SceneSpec,
): Effect.Effect<readonly [string, ImageSource], AiError.AiError, ImageGenerator> => {
  const prompt = [
    "Establishing shot for a comic scene. No people, no characters.",
    cfg.style,
    scene.description,
  ].join("\n")
  const refs = sheetsFor(sheets, scene.sheets)
  const request = {
    prompt,
    model: cfg.imageModel,
    aspectRatio: "3:2" as const,
    ...(cfg.resolution !== undefined && { resolution: cfg.resolution }),
  }
  return Effect.map(
    refs.length === 0 ? generate(request) : edit({ ...request, images: refs }),
    (response) => [scene.id, response.images[0]!.image] as const,
  )
}

// ---------------------------------------------------------------------------
// Stage 4: render
// ---------------------------------------------------------------------------

const panelPrompt = (
  cfg: BoardConfig,
  spec: ShotSpec,
  attached: ReadonlyArray<string>,
  note: string | undefined,
): string =>
  [
    `Comic panel ${spec.panel} of ${cfg.beats.length}.`,
    cfg.style,
    `Attached, in order: ${attached.join("; ")}.`,
    "Use the attached sheets as the exact reference for every character and prop shown.",
    // Without a stated order the chain gets a vote on appearance, and a
    // mistake in one panel is copied into the next as if it were canon.
    "Where the attached images disagree, the sheets win: they alone decide what anything looks like. The scene decides the place and the light. The previous panel decides only where things had got to and which way they were facing. If the previous panel contradicts a sheet, the previous panel is wrong.",
    // Asymmetry is what these models resolve by duplicating: a single
    // prosthetic arm comes back as two, a scar appears on both cheeks.
    "The sheets are complete. A character has exactly the parts their sheet shows and no others: never add a feature the sheet does not have, and never copy a feature onto the other side of a body when the sheet gives it to one side only.",
    // Each sheet fills its own square, so their apparent sizes are all equal
    // and all wrong. Without this the mug comes out the size of a head.
    "The sheets fix design and colour only. They are all drawn at the same size, which carries no meaning: sizes, poses and staging come from the shot below, and everything it describes must appear.",
    // Left to itself the model puts a person in an empty frame, and having no
    // sheet for them, invents one.
    "Draw nobody the shot does not name. If it describes no people, there are no people in it.",
    spec.prompt,
    ...(note === undefined ? [] : [`Fix on this attempt: ${note}`]),
  ].join("\n")

/**
 * Three kinds of reference, and the mix is the point. The scene anchor and
 * the sheets never change, so identity and place cannot drift. The panel
 * before carries what only a picture can: where people ended up, which way
 * they face, how the light fell. Chaining on that alone is what compounds
 * error, because each frame conditions the next; chaining while the fixed
 * anchors stay attached does not.
 */
export const render = (
  cfg: BoardConfig,
  sheets: Record<string, ImageSource>,
  scenes: Record<string, ImageSource>,
  spec: ShotSpec,
  previous: ImageSource | undefined,
  note?: string,
): Effect.Effect<Panel, AiError.AiError, ImageGenerator> => {
  const anchor = scenes[spec.scene]
  const refs: Array<readonly [string, ImageSource]> = [
    ...(anchor === undefined
      ? []
      : [["the scene's establishing shot: keep its place, light and weather", anchor] as const]),
    ...(previous === undefined
      ? []
      : [
          [
            "the previous panel, for continuity of position and light only, not for what to draw",
            previous,
          ] as const,
        ]),
    ...Arr.map(
      sheetsFor(sheets, spec.sheets),
      (image, i) => [`the ${spec.sheets[i]} sheet`, image] as const,
    ),
  ]
  return Effect.map(
    edit({
      prompt: panelPrompt(
        cfg,
        spec,
        Arr.map(refs, ([label]) => label),
        note,
      ),
      model: cfg.imageModel,
      images: Arr.map(refs, ([, image]) => image),
      aspectRatio: spec.aspect,
      ...(cfg.resolution !== undefined && { resolution: cfg.resolution }),
    }),
    (response) => ({
      index: spec.panel - 1,
      page: cfg.beats[spec.panel - 1]?.page ?? 1,
      image: response.images[0]!.image,
      sheets: spec.sheets,
    }),
  )
}

// ---------------------------------------------------------------------------
// Stage 5: critique
// ---------------------------------------------------------------------------

const Verdict = Schema.Struct({
  ok: Schema.Boolean,
  /** What drifted, phrased as an instruction for the re-render. */
  note: Schema.String,
})
export type Verdict = typeof Verdict.Type
const verdictFormat: StructuredFormat.StructuredFormat<Verdict> =
  StructuredFormat.fromEffectSchema(Verdict)

const CRITIC = [
  "You check comic panels for continuity. You are shown the scene this panel",
  "belongs to, then its reference sheets, then the rendered panel with the",
  "shot it was drawn from and the shots either side of it.",
  "",
  "Judge design, not staging. Reject only for drift a reader would notice: a",
  "face, hairstyle, colour, marking, garment or signature part that does not",
  "match its sheet, a palette or line style that breaks from the rest of the",
  "book, or lettering that should not be there.",
  "",
  "Count before you compare. Take each distinctive part in turn, the ones that",
  "make a character recognisable, and count them in the panel against the",
  "sheet. A part the sheet gives to one side of a body appearing on both, a",
  "part that is missing, a part the sheet does not have at all: each of those",
  "is drift, however well drawn. It is not staging, and an unusual angle does",
  "not excuse it.",
  "",
  "The shot outranks the sheet on everything else. Pose, camera angle,",
  "silhouette, expression, what a character is holding or has been rebuilt",
  "into: if the shot asked for it, it is correct, however far it is from the",
  "sheet. A sheet is a reference for what something is made of, not a pose to",
  "reproduce. Never reject for composition or taste.",
  "",
  "Size is judged against the shot, never against the sheets, which are all",
  "drawn at the same size. Do reject when the panel contradicts the shot on",
  "it: a droid the shot calls knee-high drawn as tall as the person, a mug as",
  "big as a head. Also reject when the shot says something is present and it",
  "is missing, or when the panel adds a character the shot never mentioned.",
  "",
  "Then read it against its neighbours, and reject a panel that cannot follow",
  "the one before or lead into the one after: a place that is not the scene",
  "you were shown, a time of day that jumped, someone holding a thing they",
  "lost, two characters whose positions cannot both be true.",
  "",
  "If you reject it, `note` is one sentence telling the artist what to change.",
].join("\n")

const imageMessage = (text: string, images: ReadonlyArray<ImageSource>): Items.HistoryItem => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text },
    ...Arr.map(images, (source) => ({ type: "input_image", source }) as const),
  ],
})

/**
 * Judged against the same images that produced it: consistency checked,
 * not hoped for. The neighbouring shots go in as text so a contradiction
 * with the panel before or after is visible; they stay text rather than
 * images so panels still render concurrently.
 */
export const critique = (
  cfg: BoardConfig,
  sheets: Record<string, ImageSource>,
  scenes: Record<string, ImageSource>,
  shots: ReadonlyArray<ShotSpec>,
  spec: ShotSpec,
  panel: Panel,
): Effect.Effect<Verdict, BoardError, LanguageModel> => {
  const anchor = scenes[spec.scene]
  const neighbour = (offset: number): ReadonlyArray<string> => {
    const other = shots[shots.indexOf(spec) + offset]
    return other === undefined
      ? []
      : [`Panel ${other.panel}${offset < 0 ? " (before)" : " (after)"}: ${other.prompt}`]
  }
  return ask(
    [
      Items.systemText(CRITIC),
      ...(anchor === undefined
        ? []
        : [imageMessage(`Scene "${spec.scene}", where this panel happens.`, [anchor])]),
      imageMessage(`Reference sheets: ${spec.sheets.join(", ")}.`, sheetsFor(sheets, spec.sheets)),
      imageMessage(
        [
          `Rendered panel ${spec.panel}. Shot: ${spec.prompt}`,
          ...neighbour(-1),
          ...neighbour(1),
        ].join("\n"),
        [panel.image],
      ),
    ],
    cfg.llmModel,
    verdictFormat,
  )
}

// ---------------------------------------------------------------------------
// Stage 5: the board
// ---------------------------------------------------------------------------

export type BoardEvent = Data.TaggedEnum<{
  SheetReady: { readonly id: string; readonly image: ImageSource; readonly millis: number }
  Directed: {
    readonly scenes: ReadonlyArray<SceneSpec>
    readonly shots: ReadonlyArray<ShotSpec>
    readonly millis: number
  }
  /** The empty stage every panel in this scene is drawn inside. */
  SceneReady: { readonly id: string; readonly image: ImageSource; readonly millis: number }
  PanelStarted: { readonly spec: ShotSpec; readonly attempt: number }
  /** The image exists but has not been judged yet. `millis` is the render alone. */
  PanelRendered: { readonly panel: Panel; readonly attempt: number; readonly millis: number }
  /** The discarded attempt, kept so a caller can see what drifted. */
  PanelRejected: {
    readonly panel: Panel
    readonly attempt: number
    readonly note: string
    /** The critique call alone. */
    readonly millis: number
  }
  PanelReady: { readonly panel: Panel; readonly millis: number }
}>
export const BoardEvent = Data.taggedEnum<BoardEvent>()

export const isPanelReady = BoardEvent.$is("PanelReady")

type Stagehand = {
  readonly sheets: Record<string, ImageSource>
  readonly scenes: Record<string, ImageSource>
  readonly shots: ReadonlyArray<ShotSpec>
}

/**
 * One panel's whole life. Bounded: a panel that keeps failing is emitted
 * with `rejected` set rather than looping forever.
 */
const panelEvents = (
  cfg: BoardConfig,
  set: Stagehand,
  spec: ShotSpec,
  previous: ImageSource | undefined,
  rounds: number,
  note?: string,
): Stream.Stream<BoardEvent, BoardError, ImageGenerator | LanguageModel> => {
  const attempt = (cfg.rounds ?? 1) - rounds + 1
  // Split so the image is emitted the moment it renders, rather than being
  // held back behind the critique call that follows it.
  const judge = (panel: Panel) =>
    Stream.unwrap(
      Effect.map(
        timed(critique(cfg, set.sheets, set.scenes, set.shots, spec, panel)),
        ([verdict, millis]) =>
          verdict.ok
            ? Stream.succeed(BoardEvent.PanelReady({ panel, millis }))
            : rounds <= 0
              ? Stream.succeed(
                  BoardEvent.PanelReady({ panel: { ...panel, rejected: verdict.note }, millis }),
                )
              : Stream.concat(
                  Stream.succeed(
                    BoardEvent.PanelRejected({ panel, attempt, note: verdict.note, millis }),
                  ),
                  // Re-render from the same references with the note appended,
                  // never from the failed panel: chaining off a bad frame keeps
                  // its mistakes.
                  panelEvents(cfg, set, spec, previous, rounds - 1, verdict.note),
                ),
      ),
    )
  return Stream.concat(
    Stream.succeed(BoardEvent.PanelStarted({ spec, attempt })),
    Stream.flatMap(
      Stream.fromEffect(timed(render(cfg, set.sheets, set.scenes, spec, previous, note))),
      ([panel, millis]) =>
        Stream.concat(
          Stream.succeed(BoardEvent.PanelRendered({ panel, attempt, millis })),
          judge(panel),
        ),
    ),
  )
}

/**
 * Panels run in order, each drawn with the one before it attached, so the
 * board reads as a sequence rather than eight independent images. The
 * fixed anchors ride along on every call, which is what keeps a chain this
 * long from drifting.
 */
const panelChain = (
  cfg: BoardConfig,
  set: Stagehand,
): Stream.Stream<BoardEvent, BoardError, ImageGenerator | LanguageModel> =>
  Stream.unwrap(
    Effect.map(Ref.make<ImageSource | undefined>(undefined), (last) =>
      Stream.flatMap(Stream.fromIterable(set.shots), (spec) =>
        Stream.unwrap(
          Effect.map(Ref.get(last), (previous) =>
            panelEvents(cfg, set, spec, previous, cfg.rounds ?? 1).pipe(
              Stream.tap((event) =>
                isPanelReady(event) ? Ref.set(last, event.panel.image) : Effect.void,
              ),
            ),
          ),
        ),
      ),
    ),
  )

export const board = (
  cfg: BoardConfig,
): Stream.Stream<BoardEvent, BoardError, ImageGenerator | LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Ref.make<Record<string, ImageSource>>({})
      const sheets = Stream.fromIterable(cfg.sheets).pipe(
        Stream.mapEffect((sheet: Sheet) => timed(sheetOf(cfg, sheet)), {
          concurrency: cfg.concurrency ?? "unbounded",
        }),
        Stream.tap(([[id, image]]) => Ref.update(ready, (r) => ({ ...r, [id]: image }))),
        Stream.map(([[id, image], millis]) => BoardEvent.SheetReady({ id, image, millis })),
      )
      // `concat` evaluates this only once the sheets have drained, so the
      // ref is complete by the time the stages read it.
      const rest = Stream.unwrap(
        Effect.gen(function* () {
          const [list, millis] = yield* timed(direct(cfg))
          const sheetsById = yield* Ref.get(ready)
          const staged = yield* Ref.make<Record<string, ImageSource>>({})
          const scenes = Stream.fromIterable(list.scenes).pipe(
            Stream.mapEffect((scene) => timed(stage(cfg, sheetsById, scene)), {
              concurrency: cfg.concurrency ?? "unbounded",
            }),
            Stream.tap(([[id, image]]) => Ref.update(staged, (r) => ({ ...r, [id]: image }))),
            Stream.map(([[id, image], ms]) => BoardEvent.SceneReady({ id, image, millis: ms })),
          )
          const panels = Stream.unwrap(
            Effect.map(Ref.get(staged), (scenesById) =>
              panelChain(cfg, { sheets: sheetsById, scenes: scenesById, shots: list.shots }),
            ),
          )
          return Stream.concat(
            Stream.succeed(BoardEvent.Directed({ scenes: list.scenes, shots: list.shots, millis })),
            Stream.concat(scenes, panels),
          )
        }),
      )
      return Stream.concat(sheets, rest)
    }),
  )
