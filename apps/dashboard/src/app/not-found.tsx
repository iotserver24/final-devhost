import Link from 'next/link';
import './not-found.css';

function Arrow({ forward = false }: { forward?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d={forward ? 'M2 8h11M8 3l5 5-5 5' : 'M3 13 13 3M6 3h7v7'} /></svg>;
}

export default function NotFound() {
  return <main className="not-found-page">
    <header className="not-found-header">
      <Link href="/landing" className="not-found-brand" aria-label="Sentinel landing page">
        <img src="/logo.png" alt="" width={34} height={34} />
        <span>SENTINEL<small>deploy watch</small></span>
      </Link>
      <span className="not-found-status">404 / PAGE NOT FOUND</span>
    </header>
    <section className="not-found-content" aria-labelledby="not-found-title">
      <p className="not-found-code" aria-hidden="true">404</p>
      <div className="not-found-copy">
        <h1 id="not-found-title">Nothing at<br />this address.</h1>
        <p>This page may have moved, or the link may be incorrect. Head back to Sentinel to find your way.</p>
        <nav className="not-found-actions" aria-label="Page recovery">
          <Link href="/landing" className="not-found-primary">Back to landing page <Arrow /></Link>
          <Link href="/" className="not-found-secondary">Open control room <Arrow forward /></Link>
        </nav>
      </div>
    </section>
    <footer className="not-found-footer">SENTINEL / DEPLOY WATCH</footer>
  </main>;
}
