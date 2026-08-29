/**
 * The corpus: one public-domain book, fetched once and cached next to the
 * database. Nothing is checked into the repo.
 */
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpClient } from "effect/unstable/http"

export const BOOK_URL = "https://www.gutenberg.org/cache/epub/1661/pg1661.txt"

const START_MARKER = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*/is
const END_MARKER = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*/is

/**
 * Drop Gutenberg's license header and footer. Text without the markers is
 * returned as-is, so a differently-packaged edition still ingests.
 */
export const stripGutenberg = (raw: string): string => {
  const start = raw.match(START_MARKER)
  const body = start?.index === undefined ? raw : raw.slice(start.index + start[0].length)
  const end = body.match(END_MARKER)
  return (end?.index === undefined ? body : body.slice(0, end.index)).trim()
}

/** Cached text if present, otherwise one GET, stripped and written through. */
export const load = (cachePath: string, url: string = BOOK_URL) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    if (yield* fs.exists(cachePath)) return yield* fs.readFileString(cachePath)

    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(url)
    const text = stripGutenberg(yield* response.text)
    yield* fs.writeFileString(cachePath, text)
    return text
  })
