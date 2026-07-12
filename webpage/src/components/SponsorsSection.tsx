import { PiArrowRight } from "react-icons/pi"

import betalyraLogo from "@/assets/betalyra-text.svg"

interface Sponsor {
  readonly name: string
  readonly href: string
  readonly logoSrc: string
}

// Third-party sponsors. These render with `rel="sponsored"` per Google's
// guidance for paid/sponsorship links. Betalyra is not listed here: it is the
// maintainer (our own company), credited below with a plain dofollow link.
const sponsors: ReadonlyArray<Sponsor> = []

export default function SponsorsSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Built and maintained by
        </span>
        <a
          href="https://betalyra.com"
          target="_blank"
          rel="noopener"
          className="outline-none transition-opacity hover:opacity-70 focus-visible:opacity-70"
        >
          <img
            src={betalyraLogo.src}
            alt="Betalyra"
            className="betalyra-logo h-14 w-auto sm:h-16"
          />
        </a>
        <a
          href="https://betalyra.com/contact"
          target="_blank"
          rel="noopener"
          className="group mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-(--color-mark) focus-visible:text-(--color-mark)"
        >
          Sponsor this project
          <PiArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      {sponsors.length > 0 && (
        <div className="mt-10 flex flex-col items-center gap-4 text-center">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Sponsors
          </span>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
            {sponsors.map(({ name, href, logoSrc }) => (
              <a
                key={name}
                href={href}
                target="_blank"
                rel="noopener sponsored"
                className="outline-none transition-opacity hover:opacity-70 focus-visible:opacity-70"
              >
                <img src={logoSrc} alt={name} className="h-12 w-auto" />
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
