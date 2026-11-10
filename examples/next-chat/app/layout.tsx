import Link from "next/link"
import type { ReactNode } from "react"
import "./globals.css"

// One app, two client stacks over the same tools: compare them side by side.
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">@effect-uai/ui</Link>
          <Link href="/ai-sdk">AI SDK useChat</Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
