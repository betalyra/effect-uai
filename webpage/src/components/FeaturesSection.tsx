import type { IconType } from "react-icons"
import {
  PiBackpack,
  PiClipboardText,
  PiGlobe,
  PiPlugs,
  PiPuzzlePiece,
  PiSlidersHorizontal,
  PiSquaresFour,
  PiTag,
  PiWaves,
} from "react-icons/pi"
import ReactMarkdown, { type Components } from "react-markdown"

interface Feature {
  readonly title: string
  readonly description: string
  readonly Icon: IconType
}

const features: ReadonlyArray<Feature> = [
  {
    title: "Explicit control",
    description: "No black-box magic. You stay in **full control** of your agent loop.",
    Icon: PiSlidersHorizontal,
  },
  {
    title: "Built on Effect",
    description:
      "**Retries**, **streams**, **concurrency**, **errors**: handled by Effect, not reinvented.",
    Icon: PiPuzzlePiece,
  },
  {
    title: "Powerful building blocks",
    description: "Small, composable primitives to assemble your own **agentic loops**.",
    Icon: PiSquaresFour,
  },
  {
    title: "Recipes for the hard parts",
    description:
      "Copy-paste solutions for **common agentic use cases** that you can adapt as needed.",
    Icon: PiClipboardText,
  },
  {
    title: "Streaming first",
    description:
      "Everything is a **stream** you can **transform**, **filter**, and **collect** when ready. Performance built in.",
    Icon: PiWaves,
  },
  {
    title: "Typed errors",
    description:
      "**Easy** and **type-safe** error handling. Match `RateLimited`, `Unavailable`, or `Timeout` directly, no string parsing.",
    Icon: PiTag,
  },
  {
    title: "Carry your own state",
    description:
      "**History**, **budget**, scratchpad: track whatever your agent needs. It's just a value.",
    Icon: PiBackpack,
  },
  {
    title: "Provider-portable",
    description:
      "Code against the generic tag. Swap **OpenAI**, **Anthropic**, **Gemini**, or **Mistral** by changing a Layer.",
    Icon: PiPlugs,
  },
  {
    title: "Platform-independent",
    description:
      "Built on Effect's platform layer, so the same agent code runs on **Bun**, **Node**, and **Deno**.",
    Icon: PiGlobe,
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>,
}

export default function FeaturesSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <h2
        style={{ marginBottom: "2rem" }}
        className="text-3xl font-bold tracking-tight text-foreground"
      >
        Features
      </h2>

      {/* Statements, not destinations: a borderless list, so it doesn't read as
          a second card grid after Capabilities. */}
      <ul className="m-0 grid list-none grid-cols-1 gap-x-10 gap-y-7 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(({ title, description, Icon }) => (
          <li key={title} className="m-0 flex gap-3.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-(--color-mark)" aria-hidden />
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold text-foreground">{title}</span>
              <span className="text-sm leading-relaxed text-muted-foreground">
                <ReactMarkdown components={markdownComponents}>{description}</ReactMarkdown>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
