import { NextResponse } from "next/server";
import { getFaultMode } from "@/lib/faults";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();
  if (mode === "healthy") return NextResponse.json({ ok: true, detail: "A task was created and read back." });
  if (mode === "ambiguous") return NextResponse.json({ ok: false, detail: "The user journey failed while every service reports ready." });
  if (mode === "config") return NextResponse.json({ ok: false, detail: "The user journey failed because a config value no longer matches the known-good billing mode." });
  if (mode === "dependency") return NextResponse.json({ ok: false, detail: "The user journey failed because the upstream dependency returned 503." });
  if (mode === "persistent") return NextResponse.json({ ok: false, detail: "The user journey failed because the task API is out of memory." });
  return NextResponse.json({ ok: false, detail: "The user journey failed after the latest deployment." });
}
