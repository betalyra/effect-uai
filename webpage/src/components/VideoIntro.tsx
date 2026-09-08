import { useEffect, useState } from "react"
import { PiArrowRight, PiPlayFill } from "react-icons/pi"

import type { Chapter } from "@/lib/intro-video"
import { cn } from "@/lib/utils"

const VIDEO_ID = "BtTi1HhyyWQ"
const TITLE = "Intro to effect-uai"

declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: Record<string, string> }) => void
  }
}

type Props = {
  /** Where on the site the player sits; sent with the Plausible play event. */
  readonly location: "landing" | "intro"
  readonly chapters?: ReadonlyArray<Chapter>
  /**
   * `stacked`: chapters under the player. `side`: chapters in a right column
   * on large screens, replaced by a link to the video page below that.
   */
  readonly layout?: "stacked" | "side"
  readonly className?: string
}

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

/**
 * Click-to-play YouTube facade. Nothing from Google loads until the visitor
 * clicks: the poster is self-hosted and the iframe only mounts on demand,
 * on the privacy-enhanced `youtube-nocookie.com` host so playback sets no
 * tracking cookies. `?play=1` (the README link) skips the facade, since
 * that click already expressed intent; `&t=<seconds>` deep-links a chapter.
 */
export function VideoIntro({ location, chapters = [], layout = "stacked", className }: Props) {
  const [start, setStart] = useState<number | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("play") === "1") setStart(Number(params.get("t")) || 0)
  }, [])

  const play = (at: number) => {
    window.plausible?.("Video play", { props: { location } })
    setStart(at)
  }

  const side = layout === "side"

  return (
    <div
      className={cn(
        "not-content",
        side ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10" : "flex flex-col gap-6",
        className,
      )}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[14px] border border-border bg-black">
        {start === null ? (
          <button
            type="button"
            onClick={() => play(0)}
            aria-label={`Play video: ${TITLE}`}
            className="group absolute inset-0 block h-full w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-(--color-mark) focus-visible:ring-inset"
          >
            <img
              src="/media/intro/poster.webp"
              alt=""
              width={1280}
              height={720}
              decoding="async"
              className="block h-full w-full object-cover"
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-(--color-mark) text-white shadow-lg transition-transform group-hover:scale-110 sm:h-20 sm:w-20">
                <PiPlayFill className="ml-1 h-7 w-7 sm:h-9 sm:w-9" aria-hidden="true" />
              </span>
            </span>
          </button>
        ) : (
          <iframe
            // Remounting on seek is simpler than the YouTube player API and
            // keeps the page free of Google scripts.
            key={start}
            className="absolute inset-0 h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&rel=0&start=${start}`}
            title={TITLE}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
      </div>

      {chapters.length > 0 && (
        <ol
          className={cn(
            "m-0 flex list-none flex-col gap-2 p-0",
            side && "hidden lg:flex lg:justify-center",
          )}
        >
          {chapters.map(({ at, label }) => (
            <li key={at} className="m-0">
              <button
                type="button"
                onClick={() => play(at)}
                className="group flex w-full cursor-pointer items-baseline gap-3 rounded-md px-1 py-0.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-(--color-mark) lg:text-base"
              >
                <span className="w-12 shrink-0 font-mono text-[0.8rem] text-(--color-mark) tabular-nums">
                  {formatTime(at)}
                </span>
                <span className="text-foreground transition-colors group-hover:text-(--color-mark)">
                  {label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {side && chapters.length > 0 && (
        <a
          href="/intro/"
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark) focus-visible:underline focus-visible:decoration-(--color-mark) lg:hidden"
        >
          All chapters
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      )}
    </div>
  )
}
