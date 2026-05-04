import { PiArrowRight, PiArrowSquareOut } from "react-icons/pi"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function GetStartedSection() {
  return (
    <section className="not-content border-t border-border pt-12 pb-8 lg:pt-16 lg:pb-10">
      <div className="flex flex-col items-center gap-6 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Ready to build your loop?
        </h2>
        <p className="max-w-[48ch] text-base leading-relaxed text-muted-foreground">
          Install the package, copy a recipe, keep your loop explicit.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-3">
          <a
            href="/start/installation/"
            className={cn(buttonVariants({ variant: "default", size: "hero" }))}
          >
            <span>Get started</span>
            <PiArrowRight aria-hidden="true" />
          </a>
          <a
            href="https://github.com/betalyra/effect-uai"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "hero" }))}
          >
            <span>View on GitHub</span>
            <PiArrowSquareOut aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  )
}
