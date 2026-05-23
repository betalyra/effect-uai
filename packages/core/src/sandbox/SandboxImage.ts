import { ImageRef, SnapshotId } from "./Sandbox.js"

/**
 * Ergonomic constructors for {@link ImageRef}. `ImageRef.*` tagged
 * constructors still exist (and are what pattern-matching code uses);
 * these helpers are what end users reach for at the call site.
 *
 * @example
 * ```ts
 * import * as Image from "@effect-uai/core/SandboxImage"
 *
 * Image.auto                         // provider's house image
 * Image.registry("python:3.12")      // OCI registry ref
 * Image.snapshot("ml-warm-1")        // restore captured state (gated)
 * Image.dockerfile("FROM ubuntu...") // build custom (gated)
 * ```
 */

export const auto: ImageRef = ImageRef.Default()

export const registry = (ref: string): ImageRef => ImageRef.Registry({ ref })

export const snapshot = (id: SnapshotId | string): ImageRef =>
  ImageRef.Snapshot({ id: SnapshotId(id) })

export const dockerfile = (contents: string): ImageRef => ImageRef.Dockerfile({ contents })
