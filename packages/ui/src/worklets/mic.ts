/**
 * The microphone worklet: device samples in, 16-bit PCM frames posted out.
 * Built as one self-contained file (`@effect-uai/ui/worklets/mic`); load it
 * with `Media.loadWorklet` or pass its URL to `Media.mic`.
 */
import { MIC_PROCESSOR, type MicProcessorOptions, micFramer } from "../internal/audio.js"

// AudioWorkletGlobalScope; TypeScript ships no lib for it.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

class Mic extends AudioWorkletProcessor {
  private readonly feed: ReturnType<typeof micFramer>
  private readonly post = (frame: ArrayBuffer) => this.port.postMessage(frame, [frame])

  constructor(options: AudioWorkletNodeOptions) {
    super()
    const { targetRate, frameMs }: MicProcessorOptions = options.processorOptions
    this.feed = micFramer(sampleRate, targetRate, frameMs)
  }

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const input = inputs[0]?.[0]
    if (input !== undefined) this.feed(input, this.post)
    return true
  }
}

registerProcessor(MIC_PROCESSOR, Mic)
