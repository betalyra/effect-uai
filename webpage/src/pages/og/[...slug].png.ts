import type { APIRoute, GetStaticPaths } from "astro"
import { getCollection } from "astro:content"
import { createOgImage } from "@/lib/og-image"

const SITE_TITLE = "effect-uai"
const SITE_TAGLINE = "Low-level primitives for AI agents in Effect."

const stubPagePattern = /^(reranking|realtime|image-generation|video-generation)(\/|$)/

type Entry = Awaited<ReturnType<typeof getCollection>>[number]

function ogSlugFor(entry: Entry): string {
  return entry.id === "index" ? "index" : entry.id
}

function eyebrowFor(entry: Entry): string | undefined {
  if (entry.id === "index") return undefined
  const top = entry.id.split("/")[0]
  if (!top) return undefined
  return top.replace(/-/g, " ")
}

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs")
  return docs
    .filter((doc) => !stubPagePattern.test(doc.id))
    .map((doc) => ({
      params: { slug: ogSlugFor(doc) },
      props: {
        title: (doc.data.hero?.title || doc.data.title || SITE_TITLE) as string,
        subtitle: (doc.data.hero?.tagline || doc.data.description || SITE_TAGLINE) as string,
        eyebrow: eyebrowFor(doc),
      },
    }))
}

export const GET: APIRoute = async ({ props }) => {
  const { title, subtitle, eyebrow } = props as {
    title: string
    subtitle: string
    eyebrow?: string
  }
  return createOgImage({ title, subtitle, eyebrow })
}
