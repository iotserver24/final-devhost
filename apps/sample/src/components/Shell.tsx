import Link from "next/link";

const links = [
  { href: "/", label: "Board" },
  { href: "/projects", label: "Projects" }
];

export function Shell({ children }: { children: React.ReactNode }) {
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
        <span><a href="/api/tasks">Task API</a> · <a href="/api/health">Health</a></span>
      </footer>
    </div>
  );
}
