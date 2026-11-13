"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";

const SITES = {
  ledger: {
    mode: "runtime",
    name: "Ledger",
    kicker: "Bad deploy",
    summary: "Checkout totals after the last release.",
    healthy: "Payments are settling on the previous good revision.",
    broken: "The latest deploy returns 500 on checkout. Sentinel restores the known-good revision.",
  },
  switchboard: {
    mode: "config",
    name: "Switchboard",
    kicker: "Broken config",
    summary: "Billing mode for new invoices.",
    healthy: "BILLING_MODE is invoice, the last known-good value.",
    broken: "A config edit changed billing mode. Sentinel restores invoice and does not guess a new value.",
  },
  hopper: {
    mode: "persistent",
    name: "Hopper",
    kicker: "Resource exhaustion",
    summary: "Queue workers and memory.",
    healthy: "Workers are under the memory cap.",
    broken: "The task API is out of memory. Sentinel restarts that service once.",
  },
  relay: {
    mode: "dependency",
    name: "Relay",
    kicker: "Failing dependency",
    summary: "Upstream catalog the store calls.",
    healthy: "The catalog dependency is answering.",
    broken: "The dependency returns 503. Sentinel restarts the dependency and leaves the app in place.",
  },
} as const;

type Slug = keyof typeof SITES;

export default function SitePage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState<Slug | null>(null);
  const [mode, setMode] = useState("healthy");

  useEffect(() => {
    void params.then(value => {
      if (value.slug in SITES) setSlug(value.slug as Slug);
      else setSlug(null);
    });
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

  if (slug === null && mode) {
    // Wait until params resolve. An unknown slug falls through below once resolved empty stays null forever only if invalid.
  }
  if (!slug) return <p className="site-wait">Loading site…</p>;
  const site = SITES[slug];
  if (!site) return notFound();
  const broken = mode === site.mode;
  return <main className={`site-page site-${slug} ${broken ? "is-broken" : "is-ok"}`}>
    <p className="site-kicker">{site.kicker}</p>
    <h1>{site.name}</h1>
    <p className="site-summary">{site.summary}</p>
    <section className="site-status" aria-live="polite">
      <strong>{broken ? "Degraded" : "Quiet"}</strong>
      <p>{broken ? site.broken : site.healthy}</p>
    </section>
  </main>;
}
