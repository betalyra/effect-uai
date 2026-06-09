import type { IconType } from "react-icons"
import {
  PiArrowRight,
  PiArrowsClockwise,
  PiArrowsInLineHorizontal,
  PiAtom,
  PiRadio,
  PiChatCircleDots,
  PiClockCounterClockwise,
  PiDetective,
  PiFlowArrow,
  PiGavel,
  PiGitFork,
  PiHandPalm,
  PiListBullets,
  PiMagnifyingGlass,
  PiMicrophone,
  PiPause,
  PiPulse,
  PiShieldCheck,
  PiStairs,
  PiTerminalWindow,
} from "react-icons/pi"
import ReactMarkdown, { type Components } from "react-markdown"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Recipe {
  readonly title: string
  readonly description: string
  readonly href: string
  readonly Icon: IconType
}

const recipes: ReadonlyArray<Recipe> = [
  {
    title: "Tool call approval",
    description:
      "**Pause on sensitive tools.** HTTP-bundled or queue-driven verdicts; same primitive.",
    href: "/recipes/tool-call-approval/",
    Icon: PiShieldCheck,
  },
  {
    title: "Live tool updates",
    description:
      "**Watch tools work.** Stream progress and reasoning as they run; the model gets one clean result.",
    href: "/recipes/streaming-tool-output/",
    Icon: PiPulse,
  },
  {
    title: "Stream typed objects",
    description:
      "**Stream data as it arrives.** Decode and validate one object at a time as the model writes.",
    href: "/recipes/streaming-structured-output/",
    Icon: PiListBullets,
  },
  {
    title: "Multi-model fallback",
    description:
      "**Stay online** when a provider fails. Switch automatically on rate limits or outages.",
    href: "/recipes/multi-model-fallback/",
    Icon: PiArrowsClockwise,
  },
  {
    title: "Model escalation",
    description:
      "**Pay only when needed.** The cheap model handles easy questions and escalates hard ones to a more capable model.",
    href: "/recipes/model-escalation/",
    Icon: PiStairs,
  },
  {
    title: "Auto-compaction",
    description:
      "**Never run out of context.** Summarize history before the token budget runs dry.",
    href: "/recipes/auto-compaction/",
    Icon: PiArrowsInLineHorizontal,
  },
  {
    title: "Pause and resume",
    description:
      "**Pause without losing progress.** Hold the loop between turns and continue right where it stopped.",
    href: "/recipes/pause-resume/",
    Icon: PiPause,
  },
  {
    title: "Mid-stream abort",
    description:
      "**Stop on a dime.** Cancel a running turn, drop the HTTP connection, and keep the partial output.",
    href: "/recipes/mid-stream-abort/",
    Icon: PiHandPalm,
  },
  {
    title: "Sleeper agent",
    description:
      "**Wait for a long-running tool call.** The agent goes quiet while the work runs and wakes up the moment it's done.",
    href: "/recipes/sleeper-agent/",
    Icon: PiDetective,
  },
  {
    title: "Agentic loop",
    description:
      "**Stay online for the whole chat.** Pull user messages from a queue; debounce bursts into one batch.",
    href: "/recipes/agentic-loop/",
    Icon: PiChatCircleDots,
  },
  {
    title: "Modify output stream",
    description:
      "**Format for the wire.** Map one function to ship the loop's output as SSE or JSONL.",
    href: "/recipes/modify-output-stream/",
    Icon: PiFlowArrow,
  },
  {
    title: "Model retry",
    description:
      "**Retry transient failures.** Exponential backoff for rate limits and timeouts; fail fast on the rest.",
    href: "/recipes/model-retry/",
    Icon: PiClockCounterClockwise,
  },
  {
    title: "Multi-model compare",
    description:
      "**See how models differ.** Send one prompt to OpenAI, Google, and Anthropic at once.",
    href: "/recipes/multi-model-compare/",
    Icon: PiGitFork,
  },
  {
    title: "Model council",
    description: "**Get the best answer.** Models judge each other, the winner streams back.",
    href: "/recipes/model-council/",
    Icon: PiGavel,
  },
  {
    title: "Voice loop",
    description:
      "**Talk to your agent.** Streaming STT, LLM, and TTS composed as Effect fibers; stop-words interrupt mid-sentence.",
    href: "/recipes/voice-loop/",
    Icon: PiMicrophone,
  },
  {
    title: "Radio station",
    description:
      "**Run your own AI radio station.** An AI DJ writes the next track while you listen to the current one; the same set replays for free.",
    href: "/recipes/radio-station/",
    Icon: PiRadio,
  },
  {
    title: "Run, fix, repeat",
    description:
      "**Let the model run its own code.** It writes Python; the sandbox runs it; tracebacks feed back into the next turn until the answer's right.",
    href: "/recipes/sandbox-code-interpreter/",
    Icon: PiTerminalWindow,
  },
  {
    title: "Grounded answer",
    description:
      "**Answer from the live web.** The model searches, reads the results, and writes a cited answer; swap the LLM and search backend independently.",
    href: "/recipes/grounded-answer/",
    Icon: PiMagnifyingGlass,
  },
  {
    title: "Deep research",
    description:
      "**Research a broad question.** Plan it into sub-questions, investigate each with a streaming sub-agent, and synthesize one cited report.",
    href: "/recipes/deep-research/",
    Icon: PiAtom,
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>,
}

export default function RecipesSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div style={{ marginBottom: "2.5rem" }} className="flex items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">Recipes</h2>
            <span className="font-mono text-[0.7rem] tracking-widest text-(--color-mark) uppercase">
              28 and counting
            </span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
            Each recipe shows how to solve a common agent problem with the primitives.
          </p>
        </div>
        <a
          href="/recipes/"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-(--color-mark)"
        >
          All recipes
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {recipes.map(({ title, description, href, Icon }) => (
          <a key={href} href={href} className="group block no-underline">
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
