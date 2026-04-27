/**
 * Compare the two `loop` implementations across iteration counts.
 * Run: `pnpm tsx experiments/streamLoopBench.ts`
 */
import { Effect, Stream } from "effect"
import * as StreamImpl from "./streamLoop.js"
import * as ChannelImpl from "./streamLoopChannel.js"

interface Impl {
  readonly loop: (
    initial: number,
    body: (n: number) => Stream.Stream<number, never, never>,
  ) => Stream.Stream<number, never, never>
  readonly next: (n: number) => unknown
  readonly stop: unknown
}

const measure = async (label: string, impl: Impl, N: number): Promise<number> => {
  const stream = impl.loop(0, (n) =>
    n >= N
      ? (Stream.fromIterable([n, impl.stop]) as Stream.Stream<number, never, never>)
      : (Stream.fromIterable([n, impl.next(n + 1)]) as Stream.Stream<number, never, never>),
  )

  const t0 = performance.now()
  const count = await Effect.runPromise(
    Stream.runFold(stream, (): number => 0, (acc) => acc + 1),
  )
  const elapsed = performance.now() - t0
  console.log(
    `${label.padEnd(8)}  N=${N.toString().padStart(7)}  count=${count.toString().padStart(7)}  ${elapsed.toFixed(0).padStart(7)}ms  (${(elapsed / N * 1000).toFixed(1)}µs/iter)`,
  )
  return elapsed
}

const streamImpl = StreamImpl as unknown as Impl
const channelImpl = ChannelImpl as unknown as Impl

const main = async () => {
  // Warm-up
  await measure("Stream", streamImpl, 100)
  await measure("Channel", channelImpl, 100)
  console.log("---")

  for (const N of [1_000, 5_000, 10_000]) {
    await measure("Stream", streamImpl, N)
    await measure("Channel", channelImpl, N)
    console.log()
  }

  // If Channel is linear, this should run quickly. If quadratic, slow.
  for (const N of [50_000, 100_000]) {
    console.log(`Channel only at N=${N}:`)
    await measure("Channel", channelImpl, N)
    console.log()
  }
}

main().catch((err) => {
  console.error("bench failed:", err)
  process.exit(1)
})
