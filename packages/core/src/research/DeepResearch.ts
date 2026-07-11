import { Context, Effect, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import * as Job from "../job/Job.js"
import type { ResearchJobRef, ResearchRequest, ResearchState } from "../domain/Research.js"
import type { Turn } from "../domain/Turn.js"
import { TurnEvent } from "../domain/Turn.js"

export type { ResearchJobRef, ResearchRequest, ResearchState } from "../domain/Research.js"

/**
 * Deep research: submit a question, watch a long-running background job, collect
 * one cited report. Every provider is modeled as a job (`submit` / `poll` /
 * `cancel`), so the surface is uniform. The convenience derivations
 * (`research` / `researchStream` / `collect` / `status`) are the same for every
 * provider and are built once by {@link fromJob}, so an implementor states only
 * its wire calls, never the poll loop.
 *
 * `research` is the blocking one-liner (submit then poll to the terminal `Turn`);
 * `researchStream` forwards live progress as `TurnEvent`s, terminating in
 * `TurnComplete` whose `turn` is the value `research` / `collect` return. The job
 * ref is plain serializable data, so it can be persisted and collected from a
 * later process where the provider's job is server-backed.
 */
export type DeepResearchServiceShape<Req> = {
  readonly submit: (request: Req) => Effect.Effect<ResearchJobRef, AiError.AiError>
  readonly status: (ref: ResearchJobRef) => Effect.Effect<ResearchState, AiError.AiError>
  readonly collect: (ref: ResearchJobRef) => Effect.Effect<Turn, AiError.AiError>
  readonly streamFrom: (ref: ResearchJobRef) => Stream.Stream<TurnEvent, AiError.AiError>
  readonly cancel: (ref: ResearchJobRef) => Effect.Effect<void, AiError.AiError>
  readonly research: (request: Req) => Effect.Effect<Turn, AiError.AiError>
  readonly researchStream: (request: Req) => Stream.Stream<TurnEvent, AiError.AiError>
}

export type DeepResearchService = DeepResearchServiceShape<ResearchRequest>

export class DeepResearch extends Context.Service<DeepResearch, DeepResearchService>()(
  "@betalyra/effect-uai/DeepResearch",
) {}

// ---------------------------------------------------------------------------
// fromJob: build the whole service from the three job ops (+ an optional real
// live stream). The derivations are identical for every provider.
// ---------------------------------------------------------------------------

/** The wire ops a provider supplies. `streamFrom` is optional: poll-only jobs
 *  get a synthesized stream ({@link synthesizedStream}) in its place. */
export type ResearchJobOps<Req> = {
  readonly submit: (request: Req) => Effect.Effect<ResearchJobRef, AiError.AiError>
  readonly poll: (ref: ResearchJobRef) => Effect.Effect<ResearchState, AiError.AiError>
  readonly cancel: (ref: ResearchJobRef) => Effect.Effect<void, AiError.AiError>
  readonly streamFrom?: (ref: ResearchJobRef) => Stream.Stream<TurnEvent, AiError.AiError>
}

// A poll-only job has no event stream, so synthesize one: a leading "searching"
// progress event, then the terminal `TurnComplete` off the poll loop. Honest
// low-fidelity progress, not a fabricated per-search feed.
const synthesizedStream = <Req>(
  ops: ResearchJobOps<Req>,
  ref: ResearchJobRef,
  config?: Job.JobConfig,
): Stream.Stream<TurnEvent, AiError.AiError> =>
  Stream.concat(
    Stream.make(TurnEvent.WebSearchCall({ status: "searching" })),
    Stream.map(Stream.fromEffect(Job.collect(ops.poll, ref, config)), (turn) =>
      TurnEvent.TurnComplete({ turn }),
    ),
  )

/**
 * Assemble a {@link DeepResearchServiceShape} from the job ops. `research` is
 * `submit` then poll-to-settle (best-effort cancel on interrupt, via
 * {@link Job.run}); `collect` / `status` are the detached equivalents;
 * `researchStream` submits then attaches. Generic over the request type so a
 * provider-typed tag keeps its narrowed `submit`. `config` tunes the poll
 * cadence and overall timeout of every derived poll loop (see
 * {@link Job.JobConfig} for the defaults).
 */
export const fromJob = <Req extends ResearchRequest>(
  ops: ResearchJobOps<Req>,
  config?: Job.JobConfig,
): DeepResearchServiceShape<Req> => {
  const streamFrom =
    ops.streamFrom ?? ((ref: ResearchJobRef) => synthesizedStream(ops, ref, config))
  return {
    submit: ops.submit,
    status: ops.poll,
    collect: (ref) => Job.collect(ops.poll, ref, config),
    cancel: ops.cancel,
    streamFrom,
    research: (request) =>
      Job.run({ submit: ops.submit(request), poll: ops.poll, cancel: ops.cancel }, config),
    researchStream: (request) => Stream.unwrap(Effect.map(ops.submit(request), streamFrom)),
  }
}

// ---------------------------------------------------------------------------
// Top-level accessors over the generic tag. Portable code uses these; they
// require only `DeepResearch` in `R`.
// ---------------------------------------------------------------------------

/** Submit and poll to the terminal `Turn`. Cancels the job on interrupt. */
export const research = (
  request: ResearchRequest,
): Effect.Effect<Turn, AiError.AiError, DeepResearch> =>
  Effect.flatMap(DeepResearch, (s) => s.research(request))

/** Submit and forward live progress, terminating in `TurnComplete`. */
export const researchStream = (
  request: ResearchRequest,
): Stream.Stream<TurnEvent, AiError.AiError, DeepResearch> =>
  Stream.unwrap(Effect.map(DeepResearch, (s) => s.researchStream(request)))

/** Submit a detached job and return its ref. */
export const submit = (
  request: ResearchRequest,
): Effect.Effect<ResearchJobRef, AiError.AiError, DeepResearch> =>
  Effect.flatMap(DeepResearch, (s) => s.submit(request))

/** Current state of a job. */
export const status = (
  ref: ResearchJobRef,
): Effect.Effect<ResearchState, AiError.AiError, DeepResearch> =>
  Effect.flatMap(DeepResearch, (s) => s.status(ref))

/** Poll a detached job to completion. */
export const collect = (ref: ResearchJobRef): Effect.Effect<Turn, AiError.AiError, DeepResearch> =>
  Effect.flatMap(DeepResearch, (s) => s.collect(ref))

/** Attach a live progress stream to a job (call again to re-attach). */
export const streamFrom = (
  ref: ResearchJobRef,
): Stream.Stream<TurnEvent, AiError.AiError, DeepResearch> =>
  Stream.unwrap(Effect.map(DeepResearch, (s) => s.streamFrom(ref)))

/** Cancel a running job. */
export const cancel = (ref: ResearchJobRef): Effect.Effect<void, AiError.AiError, DeepResearch> =>
  Effect.flatMap(DeepResearch, (s) => s.cancel(ref))
