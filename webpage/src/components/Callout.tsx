import type { ReactNode } from "react"
import { PiWarningBold } from "react-icons/pi"

// Doc callout for legacy / "prefer Responses" warnings. Renders statically in
// MDX (no client directive → no JS shipped). Mirrors the landing-page feature
// cards: a rounded-[14px] bordered panel with a bordered square icon chip
// aligned centre with the title. The reserved red mark accent marks the chip
// and triangle icon, in step with the design CI.
export default function Callout({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <aside className="my-6 rounded-[14px] border border-(--sl-color-hairline) bg-(--sl-color-bg-sidebar) px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-(--color-mark) text-(--color-mark)">
          <PiWarningBold className="h-4 w-4" />
        </div>
        {title ? (
          <p className="m-0 text-base font-semibold text-(--sl-color-white)">{title}</p>
        ) : null}
      </div>
      <div className="mt-3 text-sm leading-relaxed *:first:mt-0 *:last:mb-0">{children}</div>
    </aside>
  )
}
