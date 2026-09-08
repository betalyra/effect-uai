import { PiArrowRight } from "react-icons/pi"

import { VideoIntro } from "@/components/VideoIntro"
import { INTRO_CHAPTERS } from "@/lib/intro-video"

export default function IntroVideoSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div
        style={{ marginBottom: "1.75rem" }}
        className="flex items-baseline justify-between gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">Watch the intro</h2>
            <span className="font-mono text-[0.7rem] tracking-widest text-(--color-mark) uppercase">
              47 min
            </span>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground lg:text-base">
            Why the agent loop should be explicit, and how the primitives fit together, shown in
            code.
          </p>
        </div>
        <a
          href="/intro/"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark) focus-visible:underline focus-visible:decoration-(--color-mark)"
        >
          Open page
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      <VideoIntro location="landing" layout="side" chapters={INTRO_CHAPTERS} />
    </section>
  )
}
