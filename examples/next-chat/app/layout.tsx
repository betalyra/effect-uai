import Link from "next/link"
import type { ReactNode } from "react"
import "./globals.css"

// One app, two client stacks over the same tools: compare them side by side.
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100">
        <nav className="mx-auto flex max-w-2xl gap-4 px-6 pt-4 font-mono text-xs text-neutral-400">
          <Link href="/" className="hover:text-neutral-100">
            AI SDK useChat
          </Link>
          <Link href="/ui" className="hover:text-neutral-100">
            @effect-uai/ui
          </Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
