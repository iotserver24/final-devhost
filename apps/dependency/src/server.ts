// Minimal dependency service. The task API depends on it for user-facing ops.
// Supports a deliberate failure mode via DEMO_DEP_DOWN for the
// "failing dependency" scenario.

const port = Number(process.env.DEPENDENCY_PORT ?? 4100);

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      if (process.env.DEMO_DEP_DOWN === "1") {
        return Response.json(
          { ok: false, service: "dependency", error: "dependency deliberately down", timestamp: new Date().toISOString() },
          { status: 503 }
        );
      }
      return Response.json({ ok: true, service: "dependency", timestamp: new Date().toISOString() });
    }
    return new Response("not found", { status: 404 });
  }
});

console.log(`dependency service listening on :${port}`);
