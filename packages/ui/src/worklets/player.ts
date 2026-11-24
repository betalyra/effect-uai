/**
 * The PCM player worklet: plays queued float samples with a warmup buffer and
 * reports how much it has played. Built as one self-contained file
 * (`@effect-uai/ui/worklets/player`); load it with `Media.loadWorklet` or pass
 * its URL to `Media.pcmPlayer`.
 */
import {
  PLAYER_PROCESSOR,
  type PlayerCommand,
  type PlayerProcessorOptions,
  type PlayerReport,
  playbackQueue,
} from "../internal/audio.js"

// AudioWorkletGlobalScope; TypeScript ships no lib for it.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

class Player extends AudioWorkletProcessor {
  private readonly queue: ReturnType<typeof playbackQueue>

  constructor(options: AudioWorkletNodeOptions) {
    super()
    const { warmupMs }: PlayerProcessorOptions = options.processorOptions
    this.queue = playbackQueue((warmupMs / 1000) * sampleRate, 0.1 * sampleRate)
    this.port.onmessage = (e: MessageEvent<PlayerCommand>) => {
      if (e.data instanceof Float32Array) return this.queue.push(e.data)
      if (e.data.type === "clear") this.queue.clear()
      this.queue.reset()
      this.report(0)
    }
  }

  private report(samples: number): void {
    const report: PlayerReport = { played: (samples / sampleRate) * 1000 }
    this.port.postMessage(report)
  }

  process(_inputs: unknown, outputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const out = outputs[0]?.[0]
    if (out === undefined) return true
    const played = this.queue.pull(out)
    if (played !== undefined) this.report(played)
    return true
  }
}

registerProcessor(PLAYER_PROCESSOR, Player)
