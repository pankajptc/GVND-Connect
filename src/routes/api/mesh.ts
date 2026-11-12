import { createFileRoute } from "@tanstack/react-router";
import { handleMesh } from "@/lib/mesh/relay.server";

const handle = ({ request }: { request: Request }) => handleMesh(request);

export const Route = createFileRoute("/api/mesh")({
  server: { handlers: { GET: handle, POST: handle } },
});
