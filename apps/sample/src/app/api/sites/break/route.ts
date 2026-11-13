import { NextResponse } from "next/server";
import { isControlPinnedByEnv, setFaultMode, type FaultMode } from "@/lib/faults";

export const dynamic = "force-dynamic";

const SITES: Record<string, { mode: FaultMode; line: string }> = {
  ledger: { mode: "runtime", line: "Task service failed while reading a task." },
  switchboard: { mode: "config", line: "Task service failed because BILLING_MODE is not the known-good value." },
  hopper: { mode: "persistent", line: "Task service failed because the process is out of memory." },
  relay: { mode: "dependency", line: "Task service failed because the upstream dependency returned 503." },
};

const hits = new Map<string, { count: number; resetAt: number }>();

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const slug = body && typeof body === "object" && "slug" in body ? String((body as { slug?: unknown }).slug) : "";
  const site = SITES[slug];
  if (!site) return NextResponse.json({ ok: false, error: "Unknown site." }, { status: 404 });

  const now = Date.now();
  const bucket = hits.get(slug);
  if (!bucket || bucket.resetAt < now) hits.set(slug, { count: 1, resetAt: now + 60_000 });
  else if (bucket.count >= 8) {
    return NextResponse.json({ ok: false, error: "This site was already broken this minute. Wait, then try again." }, { status: 429 });
  } else bucket.count += 1;

  if (isControlPinnedByEnv()) {
    return NextResponse.json({ ok: false, error: "A fault is pinned by the environment." }, { status: 409 });
  }
  const state = setFaultMode(site.mode);
  const fired = 24;
  for (let index = 0; index < fired; index += 1) {
    console.error(`[${slug}] ${site.line}`);
  }
  return NextResponse.json({ ok: true, slug, mode: state.mode, fired, line: site.line });
}
