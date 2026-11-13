import './landing.css';
import { ThemeToggle } from '../../ThemeToggle';

const features = [
  { label: '01 / Detect', title: 'Failures become incidents with evidence.', body: 'Sentinel watches configured production routes and runtime errors. Repeated probe failures or matching errors can trigger an investigation.', className: 'feature-detect' },
  { label: '02 / Prove', title: 'Evidence before explanation.', body: 'Deployment state, immutable predecessor probes, runtime logs, and a chronological incident record stay in one place.', className: 'feature-prove' },
  { label: '03 / Recover', title: 'Recover when the evidence supports it.', body: 'When rollback is enabled and the checks support it, Sentinel restores the previous deployment and verifies production recovery.', className: 'feature-recover' },
  { label: '04 / Remediate', title: 'An issue, a conversation, then a fix.', body: 'Sentinel opens a GitHub issue, investigates in a sandbox, and waits for an authorized comment before fixing and verifying the regression. The resulting pull request links back to the issue.', className: 'feature-remediate' },
];

function Arrow({ direction = 'right' }: { direction?: 'right' | 'down' }) {
  return <svg className={`arrow arrow-${direction}`} viewBox="0 0 40 20" aria-hidden="true"><path d={direction === 'right' ? 'M1 10h35m-7-6 7 6-7 6' : 'M20 1v15m-6-7 6 7 6-7'} /></svg>;
}

function ExternalArrow() {
  return <svg className="external-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M6 3h7v7" /></svg>;
}

function Mark() {
  return <img className="landing-mark" src="/logo.png" alt="" />;
}

function IncidentPreview() {
  return <div className="preview-window" aria-label="Illustrative Sentinel incident dashboard preview">
    <div className="preview-topbar"><span className="preview-brand"><img src="/logo.png" alt="" /> SENTINEL</span><span>CONTROL ROOM</span><span className="preview-live"><i /> WATCHING</span></div>
    <div className="preview-workspace">
      <aside className="preview-rail"><span className="preview-overline">INCIDENTS <b>02</b></span><div className="preview-incident selected"><i className="preview-failed" /><span><b>Probe failed</b><small>production · 2m ago</small></span></div><div className="preview-incident"><i className="preview-ok" /><span><b>Build recovered</b><small>production · yesterday</small></span></div><div className="preview-watch"><span>PRODUCTION WATCH</span><b><i /> Monitoring</b><small>GET /api/health</small></div></aside>
      <div className="preview-detail"><div className="preview-title"><div><span className="preview-overline">INCIDENT / DEMO-104</span><h3>Production probe failed</h3></div><span className="preview-badge">INVESTIGATING</span></div><div className="preview-summary"><div><small>TRIGGER</small><b>HTTP 500</b><span>GET /api/health</span></div><div><small>FAILURE STREAK</small><b>02 <em>/ 03</em></b><span>same route · consecutive</span></div><div><small>DEPLOYMENT</small><b>Current revision</b><span>predecessor check pending</span></div></div><div className="preview-evidence"><div className="preview-evidence-heading"><b>Evidence</b><span>chronological record</span></div><p><i className="preview-failed" /> Current deployment returned HTTP 500 on the configured probe.</p><p><i className="preview-pending" /> Previous deployment check is still being verified.</p><p><i className="preview-neutral" /> No recovery action has been taken yet.</p></div><div className="preview-activity"><span>LIVE AGENT ACTIVITY</span><span>Waiting for a confirmed incident</span></div></div>
    </div>
    <div className="preview-caption"><span>ILLUSTRATIVE INCIDENT VIEW</span><span>STATE FIRST. EVIDENCE ALWAYS.</span></div>
  </div>;
}

export default function LandingPage() {
  return <main className="landing-page">
    <nav className="landing-nav">
      <a className="landing-brand" href="/landing" aria-label="Sentinel home"><Mark /><span>SENTINEL<small>deploy watch</small></span></a>
      <div className="landing-nav-links"><a href="#system">System</a><a href="#features">Capabilities</a><a href="#safety">Safety</a></div>
      <div className="landing-nav-actions"><ThemeToggle /><a className="nav-cta" href="/">Open control room <ExternalArrow /></a></div>
    </nav>

    <section className="landing-hero">
      <div className="hero-copy">
        <p className="hero-kicker"><i className="status-light" /> INCIDENT CONTROL</p>
        <h1>When production<br /><span>blinks,</span> Sentinel<br />keeps watch.</h1>
        <p className="hero-lede">Deployment failures are noisy. Recovery shouldn’t be. Sentinel turns a broken release into evidence, a safe decision, and a fix your team can review.</p>
        <div className="hero-actions"><a className="button button-primary" href="/">Enter the control room <ExternalArrow /></a><a className="button button-secondary" href="#system">See how it works <Arrow /></a></div>
        <div className="hero-note"><span className="note-rule" />Watch connected services. Keep every incident in view.</div>
      </div>
      <div className="hero-visual"><div className="visual-caption"><span>SENTINEL / INCIDENT VIEW</span><span>WATCH → EVIDENCE → ACTION</span></div><IncidentPreview /><p className="hero-visual-note">A single place to see what failed, what Sentinel knows, and what it has—and hasn’t—done.</p></div>
    </section>

    <section className="signal-strip" aria-label="Product capabilities"><span>INTEGRATIONS</span><strong>GitHub</strong><strong>Vercel</strong><i /><span>PLATFORM ADAPTERS</span><strong>Railway</strong><strong>Render</strong><strong>Coolify</strong><i /><span>ACTIVITY</span><strong>Agent transcript</strong><i /><span>REVIEW</span><strong>Issue + PR</strong></section>

    <section className="system-section" id="system">
      <div className="section-heading"><p>One loop. Every layer accounted for.</p><h2>From first bad response<br />to a <em>reviewable</em> fix.</h2></div>
      <div className="system-map">
        <div className="map-node node-watch"><span>WATCH</span><strong>Production<br />signals</strong><small>probes · runtime errors</small></div><Arrow />
        <div className="map-node node-evidence"><span>PROVE</span><strong>Evidence<br />stack</strong><small>logs · deploys · timeline</small></div><Arrow />
        <div className="map-node node-action"><span>RECOVER</span><strong>Guarded<br />rollback</strong><small>when enabled and safe</small></div><Arrow />
        <div className="map-node node-fix"><span>REMEDIATE</span><strong>Issue to<br />pull request</strong><small>diagnose · comment · fix</small></div>
      </div>
      <p className="system-caption"><span>THE SENTINEL LOOP</span> When remediation is configured, the issue comes first. A repository owner or authorized commenter chooses the method before the fix and pull request.</p>
    </section>

    <section className="explain-section" aria-labelledby="signals-title">
      <div className="explain-intro"><p className="section-label">THE DETAILS THAT MATTER</p><h2 id="signals-title">A failure becomes<br />a <em>clear next step.</em></h2><p>Sentinel gives each confirmed incident enough context to understand the regression and enough restraint to keep risky actions bounded.</p></div>
      <div className="explain-list">
        <article><span>01</span><div><h3>Watch the live path</h3><p>Choose a production URL and probe route. Sentinel checks it on a schedule and can also detect repeated matching runtime errors. Three consecutive probe failures can trigger an incident.</p></div></article>
        <article><span>02</span><div><h3>See the evidence together</h3><p>Review probe results, deployment status, bounded runtime or deployment logs, the affected revision, and a time-ordered incident timeline. Evidence is redacted and summarized for the dashboard.</p></div></article>
        <article><span>03</span><div><h3>Recover when it is safe</h3><p>If rollback is enabled, Sentinel checks the affected deployment and its predecessor before acting, then verifies recovery. The incident records failed or unverified recovery, and remediation can still proceed when rollback is unavailable.</p></div></article>
        <article><span>04</span><div><h3>Start with a GitHub issue</h3><p>When remediation is configured, Sentinel opens an issue first. The agent investigates the broken revision in an isolated sandbox and updates the issue with its diagnosis, a failing regression test, and a question about the proposed method.</p></div></article>
        <article><span>05</span><div><h3>Choose the method, then review the fix</h3><p>The agent pauses until the repository owner or an authorized commenter responds on the issue. It then applies the fix, runs the regression and project checks, and opens a pull request linked to the issue for a person to review and merge.</p></div></article>
      </div>
    </section>

    <section className="features-section" id="features">
      <div className="section-heading feature-heading"><p>What happens when the release is wrong</p><h2>Less panic.<br /><em>More signal.</em></h2></div>
      <div className="feature-list">{features.map((feature, index) => <article className={`feature-row ${feature.className}`} key={feature.label}><div className="feature-index">{feature.label}</div><div className="feature-copy"><h3>{feature.title}</h3><p>{feature.body}</p></div><div className="feature-visual" aria-hidden="true">{index === 0 && <><span className="big-digit">03</span><span className="visual-label">CONSECUTIVE<br />PROBE FAILURES</span></>}{index === 1 && <><span className="evidence-lines">{['HTTP 500 /api/tasks', 'deploy dpl_8f2a / failed', 'previous / verified', 'timeline / 06 events'].map(line => <i key={line}>{line}</i>)}</span></>}{index === 2 && <><svg className="rollback-arrow" viewBox="0 0 100 60"><path d="M96 30H8m25-22L8 30l25 22" /></svg><span className="visual-label">PREVIOUS<br />DEPLOYMENT</span></>}{index === 3 && <><span className="pr-box"><b>PR</b><small>LINKED</small></span><span className="visual-label">ISSUE → COMMENT<br />→ VERIFIED FIX</span></>}</div></article>)}</div>
    </section>

    <section className="safety-section" id="safety"><div className="safety-panel"><div><p className="hero-kicker"><i className="status-light" /> THE SAFETY RAIL</p><h2>Autonomy with<br /><em>a hard edge.</em></h2></div><div className="safety-points"><p><strong>01</strong> Saved secrets are write-only in the dashboard.</p><p><strong>02</strong> Rollback checks the active deployment and immediate predecessor.</p><p><strong>03</strong> Agent messages and tool details appear in a redacted transcript; private reasoning is excluded.</p><p><strong>04</strong> An authorized issue comment is required before the agent writes a fix. Pull requests are not merged automatically.</p></div></div></section>

    <section className="connect-section">
      <div className="connect-heading"><p className="section-label">FIT YOUR EXISTING STACK</p><h2>Connect your services.<br />Keep control of them.</h2><p>Configure the controller and dashboard for the services you want to watch. Monitoring, rollback, and remediation depend on your settings and connections.</p></div>
      <div className="connect-details"><div className="platform-line"><span>DEPLOYMENT PROVIDERS</span><strong>Vercel</strong><strong>Railway</strong><strong>Render</strong><strong>Coolify</strong></div><div className="connect-step"><b>01</b><p><strong>Connect your provider</strong>Connect Vercel or another supported provider, then configure the service and production probe route.</p></div><div className="connect-step"><b>02</b><p><strong>Connect GitHub</strong>Install and configure the GitHub app so Sentinel can create incident issues and pull requests in the allowed repository.</p></div><div className="connect-step"><b>03</b><p><strong>Set the safety boundaries</strong>Configure monitoring and choose whether guarded rollback and sandboxed remediation are enabled. Monitoring changes require a controller restart.</p></div><p className="connect-note">Provider credentials, service IDs, and remediation settings must be configured before their associated actions can run.</p></div>
    </section>

    <section className="closing-section"><Mark /><p>Production can be loud.<br /><strong>Your recovery path shouldn’t be.</strong></p><a className="button button-primary" href="/">Open Sentinel <ExternalArrow /></a></section>
    <footer className="landing-footer"><span>© 2026 SENTINEL</span><span>SAFE ACTIONS / CLEAR EVIDENCE</span><a href="/">CONTROL ROOM <ExternalArrow /></a></footer>
  </main>;
}
