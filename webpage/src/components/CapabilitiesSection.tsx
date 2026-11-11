import type { IconType } from "react-icons"
import {
  PiArrowRight,
  PiArticle,
  PiBrain,
  PiPhoneTransfer,
  PiBrowser,
  PiChatCircleDots,
  PiChatsCircle,
  PiCube,
  PiFilmSlate,
  PiGraph,
  PiImage,
  PiMagnifyingGlass,
  PiMusicNotes,
  PiPlus,
  PiScales,
  PiStack,
  PiWaveform,
} from "react-icons/pi"
import { RiSlackFill } from "react-icons/ri"
import { SiDiscord, SiNextdotjs, SiTanstack, SiTelegram } from "react-icons/si"
import ReactMarkdown, { type Components } from "react-markdown"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Capability {
  readonly title: string
  readonly description: string
  readonly href: string
  readonly Icon: IconType
  /** Integrations with a docs page, shown as chips on the card. */
  readonly worksWith?: ReadonlyArray<{
    readonly name: string
    readonly Icon?: IconType
  }>
}

const capabilities: ReadonlyArray<Capability> = [
  {
    title: "Language models",
    description:
      "Build **streaming**, **tool-calling** agents once, then swap the provider underneath.",
    href: "/language-models/",
    Icon: PiBrain,
  },
  {
    title: "Agentic UI",
    description:
      "Build a **chat UI** for your agent: answers **stream in live**, tool calls show up as they run.",
    href: "/agentic-ui/",
    Icon: PiChatCircleDots,
    // No FoldKit mark in react-icons yet: a text-only chip.
    worksWith: [
      { name: "Next.js", Icon: SiNextdotjs },
      { name: "TanStack Start", Icon: SiTanstack },
      { name: "FoldKit" },
    ],
  },
  {
    title: "Embeddings",
    description: "Vectorize text for **semantic search**, **RAG**, and clustering.",
    href: "/embeddings/",
    Icon: PiGraph,
  },
  {
    title: "Web search",
    description: "**Ground** answers in live web results, with citations.",
    href: "/search/",
    Icon: PiMagnifyingGlass,
  },
  {
    title: "Speech",
    description: "**Transcribe** audio and **synthesize** speech, batch or live, for voice agents.",
    href: "/speech/",
    Icon: PiWaveform,
  },
  {
    title: "Messenger",
    description:
      "Put your agent **in the chat**: it listens where people talk and streams answers back.",
    href: "/messenger/",
    Icon: PiChatsCircle,
    worksWith: [
      { name: "Telegram", Icon: SiTelegram },
      { name: "Discord", Icon: SiDiscord },
      // Simple Icons dropped Slack's mark; Remix Icon still has it.
      { name: "Slack", Icon: RiSlackFill },
    ],
  },
  {
    title: "Image generation",
    description: "**Generate** images from a prompt, then **edit** them against references.",
    href: "/image-generation/",
    Icon: PiImage,
  },
  {
    title: "Realtime",
    description:
      "**Talk to the model live.** It hears you, sees your camera, stops when you talk over it, and calls tools mid-call.",
    href: "/realtime/",
    Icon: PiPhoneTransfer,
  },
  {
    title: "Reranking",
    description: "Cut fifty candidates down to the **five worth putting in the prompt**.",
    href: "/reranking/",
    Icon: PiStack,
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
  {
    title: "Decision models",
    description:
      "Ask **typed questions** about an input and get a **probability per answer**, all in one call.",
    href: "/decisions/",
    Icon: PiScales,
  },
  {
    title: "Music generation",
    description: "Generate music from prompts, one-shot or **streaming**.",
    href: "/music-generation/",
    Icon: PiMusicNotes,
  },
  {
    title: "Video generation",
    description:
      "Generate clips as **background jobs** you can persist and resume, then stream them to disk.",
    href: "/video-generation/",
    Icon: PiFilmSlate,
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>,
}

// The whole card is the link; the arrow only confirms it on hover.
const HoverArrow = () => (
  <PiArrowRight
    aria-hidden
    className="ml-auto h-3.5 w-3.5 shrink-0 text-(--color-mark) opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
  />
)

const requestUrl =
  "https://github.com/betalyra/effect-uai/issues/new?" +
  new URLSearchParams({
    title: "Capability request: ",
    body: "What should your agent be able to do that effect-uai doesn't cover yet, and which providers would you use for it?",
  }).toString()

export default function CapabilitiesSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div style={{ marginBottom: "2rem" }} className="flex flex-col gap-1.5">
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Build agents that do more than chat
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
          Your agent can speak, listen, draw, remember, search the web, run code, join the chat, and
          show its work in your app. Each capability is one small interface, the same whichever
          provider you pick.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
        {capabilities.map(({ title, description, href, Icon, worksWith }) => (
          <a
            key={href}
            href={href}
            className="group block rounded-[14px] no-underline outline-none focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
          >
            <Card className="h-full gap-0 rounded-[14px] border-border bg-card py-5 shadow-none transition-colors hover:border-(--color-mark)">
              <CardHeader className="gap-2.5 px-6">
                <div className="flex items-center gap-3">
                  <div className="flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border text-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
                    <Icon className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-base text-foreground transition-colors group-hover:text-(--color-mark)">
                    {title}
                  </CardTitle>
                  <HoverArrow />
                </div>
                <CardDescription className="text-sm leading-relaxed">
                  <ReactMarkdown components={markdownComponents}>{description}</ReactMarkdown>
                </CardDescription>
                {worksWith !== undefined && (
                  <div className="flex flex-wrap gap-1.5">
                    {worksWith.map(({ name, Icon: Mark }) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                      >
                        {Mark !== undefined && <Mark className="h-3 w-3" aria-hidden />}
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </CardHeader>
            </Card>
          </a>
        ))}
        <a
          href={requestUrl}
          target="_blank"
          rel="noopener"
          className="group block rounded-[14px] no-underline outline-none focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
        >
          <Card className="h-full gap-0 rounded-[14px] border-dashed border-border bg-transparent py-5 shadow-none transition-colors hover:border-(--color-mark)">
            <CardHeader className="gap-2.5 px-6">
              <div className="flex items-center gap-3">
                <div className="flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border text-muted-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
                  <PiPlus className="h-4 w-4" />
                </div>
                <CardTitle className="text-base text-foreground transition-colors group-hover:text-(--color-mark)">
                  Missing a capability?
                </CardTitle>
                <HoverArrow />
              </div>
              <CardDescription className="text-sm leading-relaxed">
                Tell us what your agent needs. Open an issue on GitHub.
              </CardDescription>
            </CardHeader>
          </Card>
        </a>
      </div>
    </section>
  )
}
