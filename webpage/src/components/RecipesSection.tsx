import { useEffect, useState } from "react"
import type { IconType } from "react-icons"
import {
  PiArrowRight,
  PiArrowsClockwise,
  PiArrowsInLineHorizontal,
  PiArticle,
  PiAtom,
  PiBrowser,
  PiChartLineUp,
  PiChatCircleDots,
  PiClockCounterClockwise,
  PiCube,
  PiCursorClick,
  PiDetective,
  PiFlowArrow,
  PiFunnel,
  PiGavel,
  PiGitFork,
  PiHandPalm,
  PiListBullets,
  PiMagnifyingGlass,
  PiMicrophone,
  PiMusicNotes,
  PiNotePencil,
  PiPath,
  PiPause,
  PiPlugsConnected,
  PiPulse,
  PiQuotes,
  PiImage,
  PiImagesSquare,
  PiRadio,
  PiRanking,
  PiShieldCheck,
  PiStairs,
  PiTable,
  PiTerminalWindow,
  PiWaveform,
  PiWrench,
} from "react-icons/pi"
import ReactMarkdown, { type Components } from "react-markdown"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

// The design-problem grouping used on the /recipes docs page, not the underlying
// capability: most recipes are LLM work, so capability lumps them together while
// category tells them apart.
type Category =
  | "tools"
  | "reliability"
  | "transport"
  | "multimodel"
  | "websearch"
  | "webreading"
  | "retrieval"
  | "speech"
  | "music"
  | "images"
  | "sandboxes"
  | "browser"

interface Recipe {
  readonly title: string
  readonly description: string
  readonly href: string
  readonly Icon: IconType
  readonly category: Category
}

// Pill order mirrors the section order on the /recipes docs page.
const CATEGORY_ORDER: ReadonlyArray<Category> = [
  "tools",
  "reliability",
  "transport",
  "multimodel",
  "websearch",
  "webreading",
  "retrieval",
  "speech",
  "music",
  "images",
  "sandboxes",
  "browser",
]

const CATEGORY_LABEL: Record<Category, string> = {
  tools: "Tools & HITL",
  reliability: "Reliability",
  transport: "Transport",
  multimodel: "Multi-model",
  websearch: "Web search",
  webreading: "Web reading",
  retrieval: "Retrieval",
  speech: "Speech",
  music: "Music",
  images: "Images",
  sandboxes: "Sandboxes",
  browser: "Browser",
}

const CATEGORY_ICON: Record<Category, IconType> = {
  tools: PiWrench,
  reliability: PiArrowsClockwise,
  transport: PiFlowArrow,
  multimodel: PiGitFork,
  websearch: PiMagnifyingGlass,
  webreading: PiArticle,
  retrieval: PiFunnel,
  speech: PiWaveform,
  music: PiMusicNotes,
  images: PiImage,
  sandboxes: PiCube,
  browser: PiBrowser,
}

const recipes: ReadonlyArray<Recipe> = [
  {
    title: "Tool call approval",
    description:
      "**Pause on sensitive tools.** HTTP-bundled or queue-driven verdicts; same primitive.",
    href: "/recipes/tool-call-approval/",
    Icon: PiShieldCheck,
    category: "tools",
  },
  {
    title: "Live tool updates",
    description:
      "**Watch tools work.** Stream progress and reasoning as they run; the model gets one clean result.",
    href: "/recipes/streaming-tool-output/",
    Icon: PiPulse,
    category: "tools",
  },
  {
    title: "MCP tools",
    description:
      "**Use any MCP server's tools.** Connect, and its tools become an ordinary toolkit the loop runs; the connection closes with the stream.",
    href: "/recipes/mcp-tools/",
    Icon: PiPlugsConnected,
    category: "tools",
  },
  {
    title: "Stream typed objects",
    description:
      "**Stream data as it arrives.** Decode and validate one object at a time as the model writes.",
    href: "/recipes/streaming-structured-output/",
    Icon: PiListBullets,
    category: "tools",
  },
  {
    title: "Multi-model fallback",
    description:
      "**Stay online** when a provider fails. Switch automatically on rate limits or outages.",
    href: "/recipes/multi-model-fallback/",
    Icon: PiArrowsClockwise,
    category: "reliability",
  },
  {
    title: "Model escalation",
    description:
      "**Pay only when needed.** The cheap model handles easy questions and escalates hard ones to a more capable model.",
    href: "/recipes/model-escalation/",
    Icon: PiStairs,
    category: "multimodel",
  },
  {
    title: "Auto-compaction",
    description:
      "**Never run out of context.** Summarize history before the token budget runs dry.",
    href: "/recipes/auto-compaction/",
    Icon: PiArrowsInLineHorizontal,
    category: "reliability",
  },
  {
    title: "Pause and resume",
    description:
      "**Pause without losing progress.** Hold the loop between turns and continue right where it stopped.",
    href: "/recipes/pause-resume/",
    Icon: PiPause,
    category: "reliability",
  },
  {
    title: "Mid-stream abort",
    description:
      "**Stop on a dime.** Cancel a running turn, drop the HTTP connection, and keep the partial output.",
    href: "/recipes/mid-stream-abort/",
    Icon: PiHandPalm,
    category: "reliability",
  },
  {
    title: "Sleeper agent",
    description:
      "**Wait for a long-running tool call.** The agent goes quiet while the work runs and wakes up the moment it's done.",
    href: "/recipes/sleeper-agent/",
    Icon: PiDetective,
    category: "reliability",
  },
  {
    title: "Agentic loop",
    description:
      "**Stay online for the whole chat.** Pull user messages from a queue; debounce bursts into one batch.",
    href: "/recipes/agentic-loop/",
    Icon: PiChatCircleDots,
    category: "reliability",
  },
  {
    title: "Modify output stream",
    description:
      "**Format for the wire.** Map one function to ship the loop's output as SSE or JSONL.",
    href: "/recipes/modify-output-stream/",
    Icon: PiFlowArrow,
    category: "transport",
  },
  {
    title: "Model retry",
    description:
      "**Retry transient failures.** Exponential backoff for rate limits and timeouts; fail fast on the rest.",
    href: "/recipes/model-retry/",
    Icon: PiClockCounterClockwise,
    category: "reliability",
  },
  {
    title: "Multi-model compare",
    description:
      "**See how models differ.** Send one prompt to OpenAI, Google, and Anthropic at once.",
    href: "/recipes/multi-model-compare/",
    Icon: PiGitFork,
    category: "multimodel",
  },
  {
    title: "Model council",
    description: "**Get the best answer.** Models judge each other, the winner streams back.",
    href: "/recipes/model-council/",
    Icon: PiGavel,
    category: "multimodel",
  },
  {
    title: "Voice loop",
    description:
      "**Talk to your agent.** Streaming STT, LLM, and TTS composed as Effect fibers; stop-words interrupt mid-sentence.",
    href: "/recipes/voice-loop/",
    Icon: PiMicrophone,
    category: "speech",
  },
  {
    title: "Radio station",
    description:
      "**Run your own AI radio station.** An AI DJ writes the next track while you listen to the current one; the same set replays for free.",
    href: "/recipes/radio-station/",
    Icon: PiRadio,
    category: "music",
  },
  {
    title: "Storyboard",
    description:
      "**Tell a story in pictures.** Your characters stay themselves across every panel, so eight images read as one comic instead of eight strangers.",
    href: "/recipes/storyboard/",
    Icon: PiImagesSquare,
    category: "images",
  },
  {
    title: "Retrieve and rerank",
    description:
      "**Cosine finds related, not relevant.** Re-score the top fifteen with a cross-encoder that reads query and candidate together.",
    href: "/recipes/retrieve-and-rerank/",
    Icon: PiRanking,
    category: "retrieval",
  },
  {
    title: "Agentic search",
    description:
      "**BM25 misses paraphrases, vectors miss names.** Fuse both with RRF, rerank the head, and give it to the agent as a tool it can call again.",
    href: "/recipes/agentic-search/",
    Icon: PiPath,
    category: "retrieval",
  },
  {
    title: "Contextual retrieval",
    description:
      "**Chunking strips each passage of its referents.** An LLM writes them back at index time, ahead of both the vector and the keyword leg.",
    href: "/recipes/contextual-retrieval/",
    Icon: PiNotePencil,
    category: "retrieval",
  },
  {
    title: "Run, fix, repeat",
    description:
      "**Let the model run its own code.** It writes Python; the sandbox runs it; tracebacks feed back into the next turn until the answer's right.",
    href: "/recipes/sandbox-code-interpreter/",
    Icon: PiTerminalWindow,
    category: "sandboxes",
  },
  {
    title: "Grounded answer",
    description:
      "**Answer from the live web.** The model searches, reads the results, and writes a cited answer; swap the LLM and search backend independently.",
    href: "/recipes/grounded-answer/",
    Icon: PiQuotes,
    category: "websearch",
  },
  {
    title: "Deep research",
    description:
      "**Research a broad question.** Plan it into sub-questions, investigate each with a streaming sub-agent, and synthesize one cited report.",
    href: "/recipes/deep-research/",
    Icon: PiAtom,
    category: "websearch",
  },
  {
    title: "Market intel",
    description:
      "**Extract typed data from any page.** Read a batch of vendor pages and pull a structured pricing record from each, no selectors, concurrently.",
    href: "/recipes/market-intel/",
    Icon: PiTable,
    category: "webreading",
  },
  {
    title: "Agent usability testing",
    description:
      "**Test your UX with an agent.** Give it a goal and a URL; it drives a real browser and reports whether it got there and where it hit friction.",
    href: "/recipes/browser-usability/",
    Icon: PiCursorClick,
    category: "browser",
  },
  {
    title: "Dashboard briefing",
    description:
      "**Read dashboards like a human.** Screenshot a client-rendered dashboard and get a typed briefing: trend, anomalies, headline numbers.",
    href: "/recipes/dashboard-briefing/",
    Icon: PiChartLineUp,
    category: "browser",
  },
]

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>,
}

// Categories present in the grid, in display order, with their counts.
const pills = CATEGORY_ORDER.map((cat) => ({
  cat,
  count: recipes.filter((r) => r.category === cat).length,
})).filter((p) => p.count > 0)

const parseCat = (raw: string | null): Category | null =>
  raw !== null && raw in CATEGORY_LABEL ? (raw as Category) : null

export default function RecipesSection() {
  const [active, setActive] = useState<Category | null>(null)

  // Restore the filter from the URL on mount, then keep the URL in sync so a
  // filtered view is shareable and survives a reload.
  useEffect(() => {
    setActive(parseCat(new URLSearchParams(window.location.search).get("cat")))
  }, [])

  useEffect(() => {
    const url =
      active !== null ? `${window.location.pathname}?cat=${active}` : window.location.pathname
    window.history.replaceState(null, "", url)
  }, [active])

  // One category at a time; clicking the active pill clears back to All.
  const toggle = (cat: Category) => setActive((prev) => (prev === cat ? null : cat))

  const shown = active === null ? recipes : recipes.filter((r) => r.category === active)

  return (
    <section
      id="recipes"
      className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12"
    >
      <div
        style={{ marginBottom: "1.75rem" }}
        className="flex items-baseline justify-between gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">Recipes</h2>
            <span className="font-mono text-[0.7rem] tracking-widest text-(--color-mark) uppercase">
              40 and counting
            </span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
            Each recipe shows how to solve a common agent problem with the primitives.
          </p>
        </div>
        <a
          href="/recipes/"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark) focus-visible:underline focus-visible:decoration-(--color-mark)"
        >
          All recipes
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      <div
        style={{ marginBottom: "2.25rem" }}
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter recipes by category"
      >
        <FilterPill active={active === null} onClick={() => setActive(null)}>
          All
        </FilterPill>
        {pills.map(({ cat, count }) => {
          const CatIcon = CATEGORY_ICON[cat]
          return (
            <FilterPill key={cat} active={active === cat} onClick={() => toggle(cat)}>
              <CatIcon className="h-3 w-3" aria-hidden="true" />
              {CATEGORY_LABEL[cat]}
              <span className="tabular-nums opacity-60">{count}</span>
            </FilterPill>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
        {shown.map(({ title, description, href, Icon, category }) => {
          const CatIcon = CATEGORY_ICON[category]
          return (
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
                <CardContent className="mt-auto flex items-center justify-between px-7 pt-1">
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors group-hover:text-(--color-mark)">
                    <span>Read recipe</span>
                    <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[0.65rem] tracking-widest text-muted-foreground/55 uppercase">
                    <CatIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {CATEGORY_LABEL[category]}
                  </span>
                </CardContent>
              </Card>
            </a>
          )
        })}
      </div>
    </section>
  )
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  readonly active: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[0.7rem] tracking-widest uppercase transition-colors outline-none focus-visible:ring-1 focus-visible:ring-(--color-mark) ${
        active
          ? "border-(--color-mark) text-(--color-mark)"
          : "border-border text-muted-foreground hover:border-(--color-mark) hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}
