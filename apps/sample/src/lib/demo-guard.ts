import { NextResponse } from "next/server";

const DEMO_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Demo controls mutate process-local demo state, so they are restricted to
// loopback hosts. Anything else gets a 403 and no state change.
export function isDemoRequest(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0].toLowerCase();
  return DEMO_HOSTNAMES.has(hostname);
}

export function demoForbiddenResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Demo controls are restricted to local demo resources (localhost/127.0.0.1)"
    },
    { status: 403 }
  );
}
