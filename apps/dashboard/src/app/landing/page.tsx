import './landing.css';

const features = [
  { label: '01 / Detect', title: 'The first failure is a signal. The third is a decision.', body: 'Sentinel watches the route your users actually hit, then builds a bounded failure streak before it acts.', className: 'feature-detect' },
  { label: '02 / Prove', title: 'Evidence before explanation.', body: 'Deployment state, immutable predecessor probes, runtime logs, and a chronological incident record stay in one place.', className: 'feature-prove' },
  { label: '03 / Recover', title: 'Restore first. Fix second.', body: 'When the evidence is safe, Sentinel rolls production back to the verified predecessor and keeps the bad commit in view.', className: 'feature-recover' },
  { label: '04 / Remediate', title: 'A bounded agent, not a mystery box.', body: 'The agent works in a sandbox, runs regression checks, and opens a draft pull request. Raw tool output never leaks into the dashboard.', className: 'feature-remediate' },
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
    <div className="preview-topbar"><span className="preview-brand"><img src="/logo.png" alt="" /> SENTINEL</span><span>LOCAL CONTROL ROOM</span><span className="preview-live"><i /> WATCHING</span></div>
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
      <a className="nav-cta" href="/">Open control room <ExternalArrow /></a>
    </nav>

    <section className="landing-hero">
      <div className="hero-copy">
        <p className="hero-kicker"><i className="status-light" /> LOCAL-FIRST INCIDENT CONTROL</p>
        <h1>When production<br /><span>blinks,</span> Sentinel<br />keeps watch.</h1>
        <p className="hero-lede">Deployment failures are noisy. Recovery shouldn’t be. Sentinel turns a broken release into evidence, a safe decision, and a fix your team can review.</p>
        <div className="hero-actions"><a className="button button-primary" href="/">Enter the control room <ExternalArrow /></a><a className="button button-secondary" href="#system">See how it works <Arrow /></a></div>
        <div className="hero-note"><span className="note-rule" />Built for one explicitly configured project. Calm by design.</div>
      </div>
      <div className="hero-visual"><div className="visual-caption"><span>SENTINEL / INCIDENT VIEW</span><span>WATCH → EVIDENCE → ACTION</span></div><IncidentPreview /><p className="hero-visual-note">A single place to see what failed, what Sentinel knows, and what it has—and hasn’t—done.</p></div>
    </section>

    <section className="signal-strip" aria-label="Product capabilities"><span>INTEGRATIONS</span><strong>GitHub</strong><strong>Vercel</strong><i /><span>PLATFORM ADAPTERS</span><strong>Railway</strong><strong>Render</strong><strong>Coolify</strong><i /><span>ACTIVITY</span><strong>Live agent log</strong><i /><span>SAFE OUTPUT</span><strong>Draft PR</strong></section>

    <section className="system-section" id="system">
      <div className="section-heading"><p>One loop. Every layer accounted for.</p><h2>From first bad response<br />to a <em>reviewable</em> fix.</h2></div>
      <div className="system-map">
        <div className="map-node node-watch"><span>WATCH</span><strong>Production<br />probe</strong><small>same route · every 30s</small></div><Arrow />
        <div className="map-node node-evidence"><span>PROVE</span><strong>Evidence<br />stack</strong><small>logs · deploys · timeline</small></div><Arrow />
        <div className="map-node node-action"><span>ACT</span><strong>Guarded<br />recovery</strong><small>rollback · verify</small></div><Arrow />
        <div className="map-node node-fix"><span>FIX</span><strong>Draft pull<br />request</strong><small>sandbox · regression</small></div>
      </div>
      <p className="system-caption"><span>THE SENTINEL LOOP</span> No blind retries. No automatic merge. Every state is visible, bounded, and yours to review.</p>
    </section>

    <section className="explain-section" aria-labelledby="signals-title">
      <div className="explain-intro"><p className="section-label">THE DETAILS THAT MATTER</p><h2 id="signals-title">A failure becomes<br />a <em>clear next step.</em></h2><p>Sentinel gives each confirmed incident enough context to understand the regression and enough restraint to keep risky actions bounded.</p></div>
      <div className="explain-list">
        <article><span>01</span><div><h3>Watch the live path</h3><p>Choose a production URL and probe route. Sentinel checks the current deployment on a schedule and compares the same route against the immutable deployment before it. Repeated failures are counted before an incident is confirmed.</p></div></article>
        <article><span>02</span><div><h3>See the evidence together</h3><p>Review probe results, deployment status, bounded runtime or deployment logs, the affected revision, and a time-ordered incident timeline. Evidence is redacted and summarized for the dashboard.</p></div></article>
        <article><span>03</span><div><h3>Know why it acted—or stopped</h3><p>Rollback is considered only when project scope and predecessor checks support it, and can be disabled. If the evidence is unclear or recovery cannot be verified, the incident records that state instead of presenting a false green.</p></div></article>
        <article><span>04</span><div><h3>Review the proposed fix</h3><p>When remediation is configured, the agent investigates the incident revision in an isolated sandbox, checks the patch against regression evidence, and publishes a draft pull request for a person to review.</p></div></article>
      </div>
    </section>

    <section className="features-section" id="features">
      <div className="section-heading feature-heading"><p>What happens when the release is wrong</p><h2>Less panic.<br /><em>More signal.</em></h2></div>
      <div className="feature-list">{features.map((feature, index) => <article className={`feature-row ${feature.className}`} key={feature.label}><div className="feature-index">{feature.label}</div><div className="feature-copy"><h3>{feature.title}</h3><p>{feature.body}</p></div><div className="feature-visual" aria-hidden="true">{index === 0 && <><span className="big-digit">03</span><span className="visual-label">THRESHOLD<br />TO ACT</span></>}{index === 1 && <><span className="evidence-lines">{['HTTP 500 /api/tasks', 'deploy dpl_8f2a / failed', 'previous / verified', 'timeline / 06 events'].map(line => <i key={line}>{line}</i>)}</span></>}{index === 2 && <><svg className="rollback-arrow" viewBox="0 0 100 60"><path d="M96 30H8m25-22L8 30l25 22" /></svg><span className="visual-label">PREVIOUS<br />DEPLOYMENT</span></>}{index === 3 && <><span className="pr-box"><b>PR</b><small>DRAFT</small></span><span className="visual-label">NO MERGE<br />WITHOUT YOU</span></>}</div></article>)}</div>
    </section>

    <section className="safety-section" id="safety"><div className="safety-panel"><div><p className="hero-kicker"><i className="status-light" /> THE SAFETY RAIL</p><h2>Autonomy with<br /><em>a hard edge.</em></h2></div><div className="safety-points"><p><strong>01</strong> Secrets are write-only. Tokens stay in the controller.</p><p><strong>02</strong> Rollback is revalidated against the active project and immediate predecessor.</p><p><strong>03</strong> Agent activity is summarized. Raw reasoning and tool output stay out of the UI.</p><p><strong>04</strong> If the evidence is ambiguous, Sentinel stops and asks for a human.</p></div></div></section>

    <section className="connect-section">
      <div className="connect-heading"><p className="section-label">FIT YOUR EXISTING STACK</p><h2>Connect the project.<br />Keep control of it.</h2><p>Sentinel runs as a local controller and dashboard around one explicitly configured service. Monitoring, rollback, and remediation are opt-in settings.</p></div>
      <div className="connect-details"><div className="platform-line"><span>DEPLOYMENT PROVIDERS</span><strong>Vercel</strong><strong>Railway</strong><strong>Render</strong><strong>Coolify</strong></div><div className="connect-step"><b>01</b><p><strong>Connect Vercel</strong>Use OAuth or a project-scoped access token, then choose the project and production probe route.</p></div><div className="connect-step"><b>02</b><p><strong>Connect GitHub</strong>Install the GitHub app for repository access and draft pull request publishing.</p></div><div className="connect-step"><b>03</b><p><strong>Set the safety boundaries</strong>Configure monitoring and choose whether guarded rollback or sandboxed remediation is enabled. Settings are visible in the dashboard; the controller restarts to apply monitoring changes.</p></div><p className="connect-note">Other supported deployment providers use scoped API credentials and service-specific IDs. All provider rollback paths require a verified immediate predecessor.</p></div>
    </section>

    <section className="closing-section"><Mark /><p>Production can be loud.<br /><strong>Your recovery path shouldn’t be.</strong></p><a className="button button-primary" href="/">Open Sentinel <ExternalArrow /></a></section>
    <footer className="landing-footer"><span>© 2026 SENTINEL</span><span>LOCAL CONTROL / SAFE ACTIONS / CLEAR EVIDENCE</span><a href="/">CONTROL ROOM <ExternalArrow /></a></footer>
  </main>;
}
