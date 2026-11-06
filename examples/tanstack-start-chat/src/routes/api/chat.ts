import { createFileRoute } from "@tanstack/react-router"
import { handler } from "../../server/chat"

export const Route = createFileRoute("/api/chat")({
  server: { handlers: { POST: ({ request }) => handler(request) } },
})
