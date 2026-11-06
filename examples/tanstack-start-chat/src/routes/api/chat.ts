import { createFileRoute } from "@tanstack/react-router"
import { handle } from "../../server/chat"

export const Route = createFileRoute("/api/chat")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
})
