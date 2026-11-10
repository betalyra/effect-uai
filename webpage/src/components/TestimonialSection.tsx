import { PiHeart } from "react-icons/pi"
import ReactMarkdown, { type Components } from "react-markdown"

interface Testimonial {
  // Markdown: bold marks the phrase to emphasize, as in the feature cards.
  readonly quote: string
  readonly name: string
  readonly title: string
  readonly handle: string
  readonly href: string
  readonly avatarSrc: string
}

// Verbatim quotes, published with the author's permission.
const testimonials: ReadonlyArray<Testimonial> = [
  {
    quote:
      "Most frameworks do too much or too little, and I was worried about having to use other frameworks like LangChain or Vercel without knowing how they integrate into Effect. We found Effect-UAI at the perfect time and love that we can **control our own destiny with Effectful tooling**.",
    name: "Ani",
    title: "CTO & Co-founder, GP-LP Match",
    handle: "@aniravi24",
    href: "https://github.com/aniravi24",
    avatarSrc: "https://github.com/aniravi24.png?size=96",
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
}

const TestimonialCard = ({ t }: { t: Testimonial }) => (
  <figure className="m-0 flex h-full flex-col gap-5 rounded-[14px] border border-border bg-card px-6 py-6 transition-colors hover:border-(--color-mark)">
    <blockquote className="m-0 text-[0.95rem] leading-relaxed text-muted-foreground">
      <ReactMarkdown components={markdownComponents}>{t.quote}</ReactMarkdown>
    </blockquote>
    <figcaption className="mt-auto flex items-center gap-3">
      <img
        src={t.avatarSrc}
        alt=""
        width={36}
        height={36}
        loading="lazy"
        className="h-9 w-9 rounded-full border border-border"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">
          <span className="font-semibold">{t.name}</span>
          <span className="text-muted-foreground"> · {t.title}</span>
        </span>
        <a
          href={t.href}
          target="_blank"
          rel="noopener"
          className="font-mono text-xs text-muted-foreground no-underline transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark)"
        >
          {t.handle}
        </a>
      </span>
    </figcaption>
  </figure>
)

const issueUrl =
  "https://github.com/betalyra/effect-uai/issues/new?" +
  new URLSearchParams({
    title: "Testimonial: ",
    body: "What are you building with effect-uai, and what do you like about it?\n\nWe may quote you on effect-uai.com. Tell us the name (and link) you'd like to be credited with, or say if you'd rather we didn't.",
  }).toString()

// The last card invites the next testimonial.
const LoveCard = () => (
  <a
    href={issueUrl}
    target="_blank"
    rel="noopener"
    className="group flex h-full flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border px-6 py-6 text-center no-underline outline-none transition-colors hover:border-(--color-mark) focus-visible:border-(--color-mark)"
  >
    <span className="flex aspect-square h-9 w-9 items-center justify-center rounded-[10px] border border-border text-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
      <PiHeart className="h-4 w-4" />
    </span>
    <span className="text-base font-semibold text-foreground transition-colors group-hover:text-(--color-mark)">
      Send us your love
    </span>
    <span className="text-sm text-muted-foreground">Tell us what you're building on GitHub.</span>
  </a>
)

// With one quote, the quote and the invite share a narrow row; more quotes
// become a grid of cards like Features, with the invite last.
export default function TestimonialSection() {
  const layout =
    testimonials.length <= 1
      ? "mx-auto grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]"
      : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5"
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div className={layout}>
        {testimonials.map((t) => (
          <TestimonialCard key={t.handle} t={t} />
        ))}
        <LoveCard />
      </div>
    </section>
  )
}
