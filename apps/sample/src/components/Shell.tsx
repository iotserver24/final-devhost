"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Board" },
  { href: "/projects", label: "Projects" },
  { href: "/sites/ledger", label: "Ledger" },
  { href: "/sites/switchboard", label: "Switchboard" },
  { href: "/sites/hopper", label: "Hopper" },
  { href: "/sites/relay", label: "Relay" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pinned = process.env.NEXT_PUBLIC_SITE_SLUG;
  if (pinned || pathname.startsWith("/sites/")) return <>{children}</>;
  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Fieldnote home">
          <span className="brand-mark">F</span>
          <span>Fieldnote<span className="brand-dot">.</span></span>
        </Link>
        <nav className="nav" aria-label="Workspace">
          {links.map((link) => (
            <Link key={link.href} href={link.href}>{link.label}</Link>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="environment"><span className="pulse" /> Workspace live</span>
          <div className="avatar" aria-label="Ava">AV</div>
        </div>
      </header>
      {children}
      <footer className="page-footer">
        <span>Fieldnote workspace</span>
        <span>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API routes are not pages */}
          <a href="/api/tasks">Task API</a>
          {" · "}
          <a href="/api/health">Health</a>
        </span>
      </footer>
    </div>
  );
}
