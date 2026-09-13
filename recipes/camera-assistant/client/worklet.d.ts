/**
 * Ambient AudioWorklet globals. These live in `AudioWorkletGlobalScope`, not
 * `lib.dom`, so they need declaring for the worklet entry points. Bundled
 * separately from `main.ts` and loaded via `audioWorklet.addModule`.
 */
declare const sampleRate: number

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: {
    readonly processorOptions?: Record<string, unknown>
  }) => AudioWorkletProcessor,
): void
