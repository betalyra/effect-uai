/**
 * Browser media as Effect streams: the microphone, a camera or screen, a
 * loudness meter, and a PCM player. Browser only, and not exported from the
 * package index. Each owns its devices and audio graph through the scope it
 * runs in, so interrupting a stream releases the microphone or camera.
 *
 * The AudioWorklets ship inline (as Blob URLs), so an app serves no worklet
 * files. Audio on the wire is 16-bit little-endian PCM, mono.
 */
import * as Pcm from "@effect-uai/core/Pcm"
import { Data, Effect, Queue, Ref, type Scope, Stream } from "effect"

export class MediaError extends Data.TaggedError("MediaError")<{
  /** `denied`: the user or browser refused the device; `unavailable`: no device or no support. */
  readonly reason: "denied" | "unavailable"
  readonly message: string
}> {}

const failure = (error: unknown): MediaError => {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  return new MediaError({
    reason: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable",
    message,
  })
}

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure })

const stopTracks = (stream: MediaStream) =>
  Effect.sync(() => stream.getTracks().forEach((track) => track.stop()))

const audioContext = (options?: AudioContextOptions) =>
  Effect.acquireRelease(
    Effect.try({ try: () => new AudioContext(options), catch: failure }),
    (ctx) => Effect.promise(() => ctx.close().catch(() => undefined)),
  ).pipe(Effect.tap((ctx) => attempt(() => ctx.resume())))

const worklet = (ctx: AudioContext, source: string) =>
  Effect.acquireRelease(
    Effect.sync(() => URL.createObjectURL(new Blob([source], { type: "text/javascript" }))),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  ).pipe(Effect.flatMap((url) => attempt(() => ctx.audioWorklet.addModule(url))))

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

/**
 * Resamples to `targetRate` by averaging each output sample's input window,
 * a box filter that keeps speech free of the aliasing a plain sample pick
 * produces, and posts 16-bit frames of `frameMs`.
 */
const MIC_WORKLET = `
class EffectUaiMic extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { targetRate, frameMs } = options.processorOptions
    this.ratio = sampleRate / targetRate
    this.out = new Int16Array(Math.max(1, Math.round((targetRate * frameMs) / 1000)))
    this.n = 0
    this.sum = 0
    this.count = 0
    this.pos = 0
  }
  emit(v) {
    const c = Math.max(-1, Math.min(1, v))
    this.out[this.n++] = c < 0 ? c * 0x8000 : c * 0x7fff
    if (this.n === this.out.length) {
      this.port.postMessage(this.out.buffer.slice(0))
      this.n = 0
    }
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.pos += 1
      while (this.pos >= this.ratio) {
        this.pos -= this.ratio
        this.emit(this.count > 0 ? this.sum / this.count : input[i])
        this.sum = 0
        this.count = 0
      }
    }
    return true
  }
}
registerProcessor("effect-uai-mic", EffectUaiMic)
`

export type MicOptions = {
  /** The rate to send at, typically what the server declared on its `up` channel. */
  readonly sampleRate: number
  /** Default 50. */
  readonly frameMs?: number
  /** Default true. */
  readonly echoCancellation?: boolean
  /** Default true. */
  readonly noiseSuppression?: boolean
  /** Default true. */
  readonly autoGainControl?: boolean
}

/**
 * The microphone as 16-bit PCM frames at `sampleRate`. Asks for the device
 * when the stream starts; ending the stream releases it.
 */
export const mic = (options: MicOptions): Stream.Stream<Uint8Array, MediaError> =>
  Stream.callback<Uint8Array, MediaError>((queue) =>
    Effect.gen(function* () {
      const stream = yield* Effect.acquireRelease(
        attempt(() =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: options.echoCancellation ?? true,
              noiseSuppression: options.noiseSuppression ?? true,
              autoGainControl: options.autoGainControl ?? true,
            },
          }),
        ),
        stopTracks,
      )
      // Chrome and Safari give a MediaStreamAudioSourceNode silence unless an
      // <audio> element also consumes the stream; a muted one is enough.
      const anchor = new Audio()
      anchor.srcObject = stream
      anchor.muted = true
      yield* Effect.addFinalizer(() => Effect.sync(() => (anchor.srcObject = null)))
      yield* Effect.promise(() => anchor.play().catch(() => undefined))

      // The device's own rate; the worklet resamples.
      const ctx = yield* audioContext()
      yield* worklet(ctx, MIC_WORKLET)
      const node = new AudioWorkletNode(ctx, "effect-uai-mic", {
        processorOptions: { targetRate: options.sampleRate, frameMs: options.frameMs ?? 50 },
      })
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) =>
        Queue.offerUnsafe(queue, new Uint8Array(e.data))
      ctx.createMediaStreamSource(stream).connect(node)
      // A silent sink keeps the graph pulling on the worklet.
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(ctx.destination)
      yield* Effect.addFinalizer(() => Effect.sync(() => (node.port.onmessage = null)))
    }),
  )

/** Loudness of each 16-bit PCM frame as RMS in [0, 1], for meters and gates. */
export const level = <E, R>(pcm: Stream.Stream<Uint8Array, E, R>): Stream.Stream<number, E, R> =>
  Stream.map(pcm, (bytes) => {
    const samples = Pcm.s16leToF32(bytes)
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2
    return Math.sqrt(sum / Math.max(1, samples.length))
  })

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export type CameraOptions = {
  readonly source: "camera" | "screen"
  /** Frames per second. Default 1. */
  readonly fps?: number
  /** Longest side of a frame in pixels. Default 768. */
  readonly maxSide?: number
  /** JPEG quality in [0, 1]. Default 0.7. */
  readonly quality?: number
  /** Shows the live picture here while the stream runs. */
  readonly preview?: HTMLVideoElement
}

const jpeg = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options: CameraOptions,
): Effect.Effect<Uint8Array | undefined> =>
  Effect.gen(function* () {
    const { videoWidth: width, videoHeight: height } = video
    if (width === 0 || height === 0) return undefined
    const scale = Math.min(1, (options.maxSide ?? 768) / Math.max(width, height))
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = yield* Effect.promise(
      () =>
        new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", options.quality ?? 0.7),
        ),
    )
    return blob === null
      ? undefined
      : new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))
  })

/** A camera or the screen as JPEG frames, `fps` a second; ending the stream releases the device. */
export const camera = (options: CameraOptions): Stream.Stream<Uint8Array, MediaError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const stream = yield* Effect.acquireRelease(
        attempt(() =>
          options.source === "screen"
            ? navigator.mediaDevices.getDisplayMedia({ video: true })
            : navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1280 } },
              }),
        ),
        stopTracks,
      )
      const video = options.preview ?? document.createElement("video")
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      yield* Effect.addFinalizer(() => Effect.sync(() => (video.srcObject = null)))
      yield* attempt(() => video.play())
      const canvas = document.createElement("canvas")
      return Stream.tick(`${Math.round(1000 / (options.fps ?? 1))} millis`).pipe(
        Stream.mapEffect(() => jpeg(video, canvas, options)),
        Stream.filter((frame): frame is Uint8Array => frame !== undefined),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * Plays queued chunks in order. Holds `warmup` samples before starting so
 * early jitter is absorbed, starts anyway once that long has passed (so a
 * reply shorter than the warmup still plays), and warms up again after
 * running dry. Reports how much it has played since the last `clear` or
 * `reset`.
 */
const PLAYER_WORKLET = `
class EffectUaiPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.warmup = (options.processorOptions.warmupMs / 1000) * sampleRate
    this.reportEvery = 0.1 * sampleRate
    this.queue = []
    this.head = 0
    this.buffered = 0
    this.waited = 0
    this.started = false
    this.played = 0
    this.reported = 0
    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this.queue.push(e.data)
        this.buffered += e.data.length
        return
      }
      if (e.data.type === "clear") {
        this.queue.length = 0
        this.head = 0
        this.buffered = 0
        this.started = false
        this.waited = 0
      }
      this.played = 0
      this.reported = 0
      this.port.postMessage({ played: 0 })
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    if (!this.started) {
      if (this.buffered === 0) return true
      this.waited += out.length
      if (this.buffered < this.warmup && this.waited < this.warmup) return true
      this.started = true
    }
    let written = 0
    while (written < out.length && this.queue.length > 0) {
      const head = this.queue[0]
      const copy = Math.min(head.length - this.head, out.length - written)
      out.set(head.subarray(this.head, this.head + copy), written)
      written += copy
      this.head += copy
      if (this.head >= head.length) {
        this.queue.shift()
        this.head = 0
      }
    }
    this.buffered -= written
    this.played += written
    if (this.buffered === 0) {
      this.started = false
      this.waited = 0
    }
    if (this.played - this.reported >= this.reportEvery || this.buffered === 0) {
      this.reported = this.played
      this.port.postMessage({ played: (this.played / sampleRate) * 1000 })
    }
    return true
  }
}
registerProcessor("effect-uai-player", EffectUaiPlayer)
`

export type Player = {
  /** Queue 16-bit PCM; an odd trailing byte waits for the next chunk. */
  readonly push: (bytes: Uint8Array) => Effect.Effect<void>
  /** Drop everything queued (a stopped reply) and restart the count. */
  readonly clear: Effect.Effect<void>
  /** Restart the count without dropping anything (a new reply begins). */
  readonly reset: Effect.Effect<void>
  /** Milliseconds played since the last `clear` or `reset`. */
  readonly played: Effect.Effect<number>
}

export type PlayerOptions = {
  /** The rate of the audio pushed, typically from its `channel-opened`. */
  readonly sampleRate: number
  /** Default 200. */
  readonly warmupMs?: number
}

/**
 * A PCM player for the lifetime of the scope. Create it after a user gesture
 * (a click), or the browser keeps its audio suspended.
 */
export const pcmPlayer = (options: PlayerOptions): Effect.Effect<Player, MediaError, Scope.Scope> =>
  Effect.gen(function* () {
    const ctx = yield* audioContext({ sampleRate: options.sampleRate })
    yield* worklet(ctx, PLAYER_WORKLET)
    const node = new AudioWorkletNode(ctx, "effect-uai-player", {
      processorOptions: { warmupMs: options.warmupMs ?? 200 },
    })
    node.connect(ctx.destination)
    const played = yield* Ref.make(0)
    const carry = yield* Ref.make<Uint8Array>(new Uint8Array(0))
    node.port.onmessage = (e: MessageEvent<{ readonly played: number }>) =>
      Effect.runSync(Ref.set(played, e.data.played))
    yield* Effect.addFinalizer(() => Effect.sync(() => (node.port.onmessage = null)))

    const push = (bytes: Uint8Array) =>
      Effect.flatMap(
        Ref.modify(carry, (rest): readonly [Uint8Array, Uint8Array] => {
          const joined = new Uint8Array(rest.byteLength + bytes.byteLength)
          joined.set(rest)
          joined.set(bytes, rest.byteLength)
          const cut = joined.byteLength - (joined.byteLength % 2)
          return [joined.subarray(0, cut), joined.slice(cut)]
        }),
        (whole) =>
          Effect.sync(() => {
            if (whole.byteLength === 0) return
            const samples = Pcm.s16leToF32(whole)
            node.port.postMessage(samples, [samples.buffer])
          }),
      )

    const send = (type: "clear" | "reset") =>
      Effect.andThen(
        type === "clear" ? Ref.set(carry, new Uint8Array(0)) : Effect.void,
        Effect.andThen(
          Ref.set(played, 0),
          Effect.sync(() => node.port.postMessage({ type })),
        ),
      )

    return { push, clear: send("clear"), reset: send("reset"), played: Ref.get(played) }
  })
