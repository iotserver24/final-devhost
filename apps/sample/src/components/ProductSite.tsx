"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";

const SITES = {
  ledger: {
    mode: "runtime",
    name: "Ledger",
    product: "Checkout",
    kicker: "Bad deploy",
    summary: "Totals after the last release.",
    healthy: "Payments are settling on the previous good revision.",
    broken: "The latest deploy returns 500 on checkout. Sentinel restores the known-good revision.",
  },
  switchboard: {
    mode: "config",
    name: "Switchboard",
    product: "Billing",
    kicker: "Broken config",
    summary: "The live billing mode.",
    healthy: "BILLING_MODE is invoice, the last known-good value.",
    broken: "A config edit changed billing mode. Sentinel restores invoice and does not guess a new value.",
  },
  hopper: {
    mode: "persistent",
    name: "Hopper",
    product: "Queue",
    kicker: "Resource exhaustion",
    summary: "Workers and memory.",
    healthy: "Workers are under the memory cap.",
    broken: "The task API is out of memory. Sentinel restarts that service once.",
  },
  relay: {
    mode: "dependency",
    name: "Relay",
    product: "Catalog",
    kicker: "Failing dependency",
    summary: "The upstream the store calls.",
    healthy: "The catalog dependency is answering.",
    broken: "The dependency returns 503. Sentinel restarts the dependency and leaves the app in place.",
  },
} as const;

type Slug = keyof typeof SITES;

export function ProductSite({ initialSlug, params }: { initialSlug?: string; params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState<Slug | "missing" | null>(initialSlug && initialSlug in SITES ? initialSlug as Slug : null);
  const [mode, setMode] = useState("healthy");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void params.then(value => setSlug(value.slug in SITES ? value.slug as Slug : "missing"));
    const load = () => {
      void fetch("/api/demo/faults", { cache: "no-store" })
        .then(response => response.json())
        .then(body => setMode(String(body?.state?.mode ?? "healthy")))
        .catch(() => setMode("unknown"));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [params]);

  if (slug === "missing") return notFound();
  if (!slug) return <p className="site-wait">Loading site…</p>;
  const site = SITES[slug];
  const broken = mode === site.mode;

  async function trigger() {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/sites/break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const body = await response.json().catch(() => ({})) as { fired?: number; error?: string; mode?: string };
      if (!response.ok) {
        setNote(body.error || "The burst did not start.");
        return;
      }
      if (body.mode) setMode(body.mode);
      setNote(`Sent ${body.fired ?? 0} server errors. Sentinel reads them from the host logs.`);
    } catch {
      setNote("The burst did not start.");
    } finally {
      setBusy(false);
    }
  }

  return <main className={`product product-${slug} ${broken ? "is-broken" : "is-ok"}`}>
    <header>
      <span>{site.product}</span>
      <strong>{broken ? "Degraded" : "Quiet"}</strong>
    </header>
    <p className="site-kicker">{site.kicker}</p>
    <h1>{site.name}</h1>
    <p className="site-summary">{site.summary}</p>
    <section className="site-status" aria-live="polite">
      <p>{broken ? site.broken : site.healthy}</p>
    </section>
    <button type="button" onClick={() => void trigger()} disabled={busy}>
      {busy ? "Sending errors…" : "Trigger a burst of errors"}
    </button>
    {note && <p className="site-note">{note}</p>}
  </main>;
}
