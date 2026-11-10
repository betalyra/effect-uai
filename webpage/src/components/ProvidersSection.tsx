import type { IconType } from "react-icons"
import { PiArrowRight, PiPlus } from "react-icons/pi"
import { RiOpenaiFill, RiSlackFill } from "react-icons/ri"
import {
  SiAnthropic,
  SiDeno,
  SiDiscord,
  SiElevenlabs,
  SiGooglegemini,
  SiMistralai,
  SiPerplexity,
  SiTelegram,
} from "react-icons/si"

interface Provider {
  readonly name: string
  readonly href: string
  /** The brand mark, where an icon set has one. */
  readonly Icon?: IconType
}

// Best known first.
const providers: ReadonlyArray<Provider> = [
  { name: "OpenAI", href: "/providers/responses/", Icon: RiOpenaiFill },
  { name: "Anthropic", href: "/providers/anthropic/", Icon: SiAnthropic },
  { name: "Google", href: "/providers/gemini/", Icon: SiGooglegemini },
  { name: "Mistral", href: "/providers/mistral/", Icon: SiMistralai },
  { name: "Slack", href: "/messenger/providers/slack/", Icon: RiSlackFill },
  { name: "Discord", href: "/messenger/providers/discord/", Icon: SiDiscord },
  { name: "Telegram", href: "/messenger/providers/telegram/", Icon: SiTelegram },
  { name: "Perplexity", href: "/search/providers/perplexity/", Icon: SiPerplexity },
  { name: "ElevenLabs", href: "/speech/providers/elevenlabs/", Icon: SiElevenlabs },
  { name: "Deno", href: "/sandboxes/providers/deno/", Icon: SiDeno },
  { name: "Fal", href: "/image-generation/providers/fal/" },
  { name: "Firecrawl", href: "/web-reading/providers/firecrawl/" },
  { name: "Exa", href: "/search/providers/exa/" },
  { name: "Tavily", href: "/search/providers/tavily/" },
  { name: "Jina", href: "/embeddings/providers/jina/" },
  { name: "Inworld", href: "/speech/providers/inworld/" },
  { name: "Microsandbox", href: "/sandboxes/providers/microsandbox/" },
  { name: "TypeSafe AI", href: "/decisions/providers/typesafe-ai/" },
  { name: "CDP", href: "/browser/providers/cdp/" },
]

const requestUrl =
  "https://github.com/betalyra/effect-uai/issues/new?" +
  new URLSearchParams({
    title: "Provider request: ",
    body: "Which provider (and which of its APIs: chat, speech, embeddings, ...) would you like to see, and what would you use it for?",
  }).toString()

export default function ProvidersSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div style={{ marginBottom: "2rem" }} className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            19 providers. Swap anytime.
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
            Write against a shared interface and switch providers without touching your agent code.
          </p>
        </div>
        <a
          href="/providers/"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark) focus-visible:underline focus-visible:decoration-(--color-mark)"
        >
          All providers
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {providers.map(({ name, href, Icon }) => (
          <a
            key={name}
            href={href}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground no-underline transition-colors outline-none hover:border-(--color-mark) hover:text-(--color-mark) focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
          >
            {Icon !== undefined && <Icon className="h-3.5 w-3.5" aria-hidden />}
            {name}
          </a>
        ))}
        <a
          href={requestUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-full border border-dashed border-border px-4 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors outline-none hover:border-(--color-mark) hover:text-(--color-mark) focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
        >
          <PiPlus className="h-3.5 w-3.5" aria-hidden />
          Missing a provider?
        </a>
      </div>
    </section>
  )
}
