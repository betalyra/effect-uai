import { PiArrowRight } from "react-icons/pi"

interface Provider {
  readonly name: string
  readonly href: string
}

const providers: ReadonlyArray<Provider> = [
  { name: "OpenAI", href: "/providers/responses/" },
  { name: "Anthropic", href: "/providers/anthropic/" },
  { name: "Google", href: "/providers/gemini/" },
  { name: "Mistral", href: "/providers/mistral/" },
  { name: "fal", href: "/image-generation/providers/fal/" },
  { name: "ElevenLabs", href: "/speech/providers/elevenlabs/" },
  { name: "Inworld", href: "/speech/providers/inworld/" },
  { name: "Jina", href: "/embeddings/providers/jina/" },
  { name: "Perplexity", href: "/search/providers/perplexity/" },
  { name: "Exa", href: "/search/providers/exa/" },
  { name: "Tavily", href: "/search/providers/tavily/" },
  { name: "Firecrawl", href: "/web-reading/providers/firecrawl/" },
  { name: "Microsandbox", href: "/sandboxes/providers/microsandbox/" },
  { name: "Deno", href: "/sandboxes/providers/deno/" },
  { name: "CDP", href: "/browser/providers/cdp/" },
  { name: "Telegram", href: "/messenger/providers/telegram/" },
  { name: "Discord", href: "/messenger/providers/discord/" },
]

export default function ProvidersSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div style={{ marginBottom: "2rem" }} className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            17 providers. Swap anytime.
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
        {providers.map(({ name, href }) => (
          <a
            key={name}
            href={href}
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground no-underline transition-colors outline-none hover:border-(--color-mark) hover:text-(--color-mark) focus-visible:ring-1 focus-visible:ring-(--color-border) focus-visible:ring-offset-2 focus-visible:ring-offset-(--sl-color-bg) hover:focus-visible:ring-(--color-mark)"
          >
            {name}
          </a>
        ))}
      </div>
    </section>
  )
}
