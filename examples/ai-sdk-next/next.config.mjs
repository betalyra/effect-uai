import path from "node:path"

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Local-monorepo artifact: the effect-uai packages are linked from `../../`,
  // so Turbopack must root at the repo to follow those symlinks. A copy of this
  // example using published @effect-uai/* packages should delete this block.
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
  },
}

export default nextConfig
