function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleMesh(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json({
      app: "GVND Connect",
      mode: "gundb-crdt + sha256-indexeddb-swarm",
      items: [],
    });
  }
  if (request.method === "POST") {
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
