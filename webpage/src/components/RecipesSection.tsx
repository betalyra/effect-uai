import type { IconType } from "react-icons"
import {
  PiArrowRight,
  PiArrowsClockwise,
  PiArrowsInLineHorizontal,
  PiGavel,
  PiGitFork,
  PiHandPalm,
  PiHandWaving,
  PiPause,
} from "react-icons/pi"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface Recipe {
  readonly title: string
  readonly description: string
  readonly href: string
  readonly Icon: IconType
}

const recipes: ReadonlyArray<Recipe> = [
  {
    title: "Basic usage",
    description:
      "The smallest end-to-end shape: streaming deltas, a tool call, and a final answer.",
    href: "/recipes/basic-usage/",
    Icon: PiHandWaving,
  },
  {
    title: "Multi-model fallback",
    description: "Fall back across providers on RateLimited / Unavailable.",
    href: "/recipes/multi-model-fallback/",
    Icon: PiArrowsClockwise,
  },
  {
    title: "Auto-compaction",
    description: "Summarize history when token / turn budget is exceeded.",
    href: "/recipes/auto-compaction/",
    Icon: PiArrowsInLineHorizontal,
  },
  {
    title: "Pause and resume",
    description:
      "Checkpoint after each turn, resume later via previousResponseId.",
    href: "/recipes/pause-resume/",
    Icon: PiPause,
  },
  {
    title: "Mid-stream abort",
    description:
      "Cancel the loop and the upstream HTTP request via scope-based cleanup.",
    href: "/recipes/mid-stream-abort/",
    Icon: PiHandPalm,
  },
  {
    title: "Multi-model compare",
    description:
      "Fan one prompt out to OpenAI, Google, and Anthropic concurrently.",
    href: "/recipes/multi-model-compare/",
    Icon: PiGitFork,
  },
  {
    title: "Model council",
    description:
      "Same fan-out, but the models cross-evaluate and the winner is streamed back.",
    href: "/recipes/model-council/",
    Icon: PiGavel,
  },
]

export default function RecipesSection() {
  return (
    <section className="not-content mt-20 mb-24 border-t border-border pt-16 lg:mt-24 lg:pt-20">
      <div
        style={{ marginBottom: "2.5rem" }}
        className="flex items-baseline justify-between gap-4"
      >
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Recipes
        </h2>
        <a
          href="/recipes/"
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-(--color-mark)"
        >
          All recipes
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {recipes.map(({ title, description, href, Icon }) => (
          <a key={href} href={href} className="group block no-underline">
            <Card className="h-full gap-5 border-border bg-card py-7 shadow-none transition-colors hover:border-(--color-mark)">
              <CardHeader className="gap-3 px-7">
                <div className="mb-2 flex h-10 w-10 items-center justify-center border border-border text-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
                  <Icon className="h-4 w-4" />
                </div>
                <CardTitle className="text-base text-foreground transition-colors group-hover:text-(--color-mark)">
                  {title}
                </CardTitle>
                <CardDescription className="text-sm leading-relaxed">
                  {description}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex items-center gap-1.5 px-7 pt-1 text-sm text-muted-foreground transition-colors group-hover:text-(--color-mark)">
                <span>Read recipe</span>
                <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
    </section>
  )
}
