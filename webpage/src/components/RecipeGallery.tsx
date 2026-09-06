import { useState } from "react"
import { PiXBold } from "react-icons/pi"

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"

type Slide = {
  /** Path under `public/`. */
  readonly src: string
  /** Shown under this slide. For an edit session, the request that made it. */
  readonly caption?: string
}

type Props = {
  readonly images: ReadonlyArray<Slide>
  readonly caption?: string
}

/**
 * What a recipe produced, shown under the page title.
 *
 * Slides are sized by height rather than by a basis fraction, so panels
 * keep their own aspect ratios and several fit at once: the point of the
 * strip is that you can see a sequence side by side, not one frame at a
 * time. Height is fixed, so the code below stays near the top of the page
 * however many images there are.
 */
export function RecipeGallery({ caption, images }: Props) {
  const [open, setOpen] = useState<number | null>(null)

  return (
    // `overflow-hidden` because shadcn hangs the arrows outside the
    // container by default; they are pulled back in below.
    <figure className="not-content my-5 overflow-hidden">
      <Carousel
        opts={{ align: "start", dragFree: true, containScroll: "trimSnaps" }}
        className="px-11"
      >
        <CarouselContent className="items-start">
          {images.map(({ caption: label, src }, i) => (
            <CarouselItem key={src} className="flex basis-auto flex-col gap-2">
              <button
                type="button"
                onClick={() => setOpen(i)}
                aria-label={`Enlarge image ${i + 1} of ${images.length}`}
                // `block` on both, or the button's inline baseline leaves a
                // strip of its own background under the image.
                className="block h-40 cursor-pointer overflow-hidden rounded-xl border bg-card shadow-sm transition-colors hover:border-(--color-mark) focus-visible:border-(--color-mark) focus-visible:outline-none sm:h-64 lg:h-80"
              >
                <img
                  src={src}
                  alt=""
                  loading={i < 3 ? "eager" : "lazy"}
                  decoding="async"
                  className="block h-full w-auto"
                />
              </button>
              {label !== undefined && (
                <p className="max-w-xs text-(length:--sl-text-xs) text-(--sl-color-gray-3)">
                  {label}
                </p>
              )}
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="left-0" />
        <CarouselNext className="right-0" />
      </Carousel>

      {caption !== undefined && (
        <figcaption className="mt-2 px-14 text-(length:--sl-text-sm) text-(--sl-color-gray-3)">
          {caption}
        </figcaption>
      )}

      {open !== null && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-100 flex items-center justify-center bg-black/85 p-8"
        >
          <img
            src={images[open]?.src}
            alt=""
            className="max-h-full max-w-full rounded-md object-contain"
          />
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full p-2 text-white/70 transition-colors hover:text-white"
          >
            <PiXBold />
          </button>
        </div>
      )}
    </figure>
  )
}
