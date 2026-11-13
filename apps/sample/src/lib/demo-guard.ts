import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

const DEMO_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Demo controls are OFF by default. Enabling them requires both
// DEMO_CONTROLS_ENABLED=true and a non-empty DEMO_CONTROL_TOKEN, and every
// mutation must present that token as a Bearer token. The Host header is
// only a defense-in-depth loopback check — it is never treated as
// authentication, because a remote client can spoof it.
export function demoControlsEnabled(): boolean {
  return process.env.DEMO_CONTROLS_ENABLED === "true";
}

function tokenMatches(request: Request): boolean {
  const expected = process.env.DEMO_CONTROL_TOKEN ?? "";
  if (!demoControlsEnabled() || expected.length === 0) return false;
  const received = Buffer.from(
    request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? ""
  );
  const expectedBuffer = Buffer.from(expected);
  return (
    received.length === expectedBuffer.length &&
    timingSafeEqual(received, expectedBuffer)
  );
}

function isLoopbackHost(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0].toLowerCase();
  return DEMO_HOSTNAMES.has(hostname);
}

// Authorization boundary for mutating demo controls. A spoofed Host header
// alone never authorizes a mutation.
export function authorizeDemoMutation(request: Request): boolean {
  return tokenMatches(request) && isLoopbackHost(request);
}

export function demoDisabledResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Demo controls are disabled. Set DEMO_CONTROLS_ENABLED=true and DEMO_CONTROL_TOKEN, and bind the app to loopback for local demos."
    },
    { status: 403 }
  );
}

export function demoUnauthorizedResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "Demo control token missing or invalid."
    },
    { status: 401 }
  );
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
