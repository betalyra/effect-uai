import type { IconType } from "react-icons"
import {
  PiArrowRight,
  PiArticle,
  PiBrain,
  PiBrowser,
  PiCube,
  PiGraph,
  PiImage,
  PiMagnifyingGlass,
  PiMusicNotes,
  PiStack,
  PiWaveform,
} from "react-icons/pi"
import ReactMarkdown, { type Components } from "react-markdown"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Capability {
  readonly title: string
  readonly description: string
  readonly href: string
  readonly Icon: IconType
}

const capabilities: ReadonlyArray<Capability> = [
  {
    title: "Language models",
    description:
      "Build streaming, tool-calling agents over **OpenAI**, **Anthropic**, **Gemini**, and **Mistral**.",
    href: "/language-models/",
    Icon: PiBrain,
  },
  {
    title: "Image generation",
    description:
      "Generate images from a prompt, then **edit** them against references so a character stays itself.",
    href: "/image-generation/",
    Icon: PiImage,
  },
  {
    title: "Speech",
    description: "**Transcribe** audio and **synthesize** speech, batch or live, for voice agents.",
    href: "/speech/",
    Icon: PiWaveform,
  },
  {
    title: "Music generation",
    description: "Generate music from prompts, one-shot or **streaming**.",
    href: "/music-generation/",
    Icon: PiMusicNotes,
  },
  {
    title: "Embeddings",
    description: "Vectorize text for **semantic search**, **RAG**, and clustering.",
    href: "/embeddings/",
    Icon: PiGraph,
  },
  {
    title: "Reranking",
    description: "Cut fifty candidates down to the **five worth putting in the prompt**.",
    href: "/reranking/",
    Icon: PiStack,
  },
  {
    title: "Web search",
    description: "**Ground** answers in live web results, with citations.",
    href: "/search/",
    Icon: PiMagnifyingGlass,
  },
  {
    title: "Web reading",
    description: "Turn any **URL into clean markdown**, then extract typed data from it.",
    href: "/web-reading/",
    Icon: PiArticle,
  },
  {
    title: "Sandboxes",
    description: "Run **model-written code** in isolated microVMs.",
    href: "/sandboxes/",
    Icon: PiCube,
  },
  {
    title: "Browser",
    description: "Drive a **real browser**: navigate, click, fill, and read pages as markdown.",
    href: "/browser/",
    Icon: PiBrowser,
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>,
}

export default function CapabilitiesSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div style={{ marginBottom: "2rem" }} className="flex flex-col gap-1.5">
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Build agents that do more than chat
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
          Your agent can speak, listen, draw, remember, search the web, and run code. Each
          capability is one small interface, the same whichever provider you pick.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {capabilities.map(({ title, description, href, Icon }) => (
          <a
            key={href}
            href={href}
            className="group block rounded-[14px] no-underline outline-none focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
          >
            <Card className="h-full gap-5 rounded-[14px] border-border bg-card py-7 shadow-none transition-colors hover:border-(--color-mark)">
              <CardHeader className="gap-3 px-7">
                <div className="flex items-center gap-3">
                  <div className="flex aspect-square h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-border text-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
                    <Icon className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-base text-foreground transition-colors group-hover:text-(--color-mark)">
                    {title}
                  </CardTitle>
                </div>
                <CardDescription className="text-sm leading-relaxed">
                  <ReactMarkdown components={markdownComponents}>{description}</ReactMarkdown>
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex items-center gap-1.5 px-7 pt-1 text-sm text-muted-foreground transition-colors group-hover:text-(--color-mark)">
                <span>Explore</span>
                <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </CardContent>
            </Card>
          </a>
        ))}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">And more coming soon.</p>
    </section>
  )
}
