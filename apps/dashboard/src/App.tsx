'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Setup } from './Setup';
import {
  decisionLabels,
  kindLabels,
  rollbackCaveat,
  statusLabels,
  type Incident,
} from '@nexathon/notifier/format';
import { useIncidents, type DataMode } from './useIncidents';
import { AgentTranscript } from './AgentTranscript';
import { useActivity } from './useActivity';

const mode: DataMode = process.env.NEXT_PUBLIC_DATA_MODE === 'fixtures' ? 'fixtures' : 'live';

const runStatusLabels: Record<string, string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Stopped',
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortSha(value?: string) {
  return value ? value.slice(0, 7) : '—';
}

function shortDeployment(value?: string) {
  return value ? value.replace(/^dpl_/, '').slice(0, 7) : '—';
}

function everyLabel(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 120 ? `${Math.max(1, Math.round(seconds / 60))}m` : `${seconds}s`;
}

function nextIn(from: string | null | undefined, intervalMs: number, now: Date) {
  if (!from) return '—';
  const remaining = Math.ceil((new Date(from).getTime() + intervalMs - now.getTime()) / 1000);
  return remaining <= 0 ? 'due' : `${remaining}s`;
}

function hostOf(value?: string) {
  if (!value) return '—';
  try { return new URL(value).host; } catch { return value; }
}

function StatusPill({ status }: { status: Incident['status'] }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

function rolledBack(incident: Incident) {
  return incident.events.some(event => event.type === 'rollback_started' || event.type === 'rollback_completed');
}

function actionSummary(incident: Incident) {
  const restored = rolledBack(incident);
  if (incident.status === 'rolling_back') return 'Rolling production back to the previous deploy. The fix starts after that.';
  if (incident.status === 'remediating' && restored) return 'Production was rolled back. The agent is fixing the bad commit and will open a pull request.';
  if (incident.status === 'remediating') return 'The agent is fixing the bad commit and will open a pull request.';
  if (incident.status === 'pr_opened' && restored) return 'Production was rolled back, then a fix pull request was opened. Nothing has been merged.';
  if (incident.status === 'pr_opened') return 'A pull request is open for review. Nothing has been merged.';
  if (incident.status === 'recovered' && restored) return 'Production was restored to the previous deploy. The fix follows that rollback.';
  if (incident.status === 'recovered') return 'Production recovery was verified after the guarded action.';
  if (incident.status === 'remediation_failed') return [...incident.events].reverse()
    .find(event => event.type === 'remediation_failed')?.message ?? 'The latest fix attempt failed. See the timeline for details.';
  if (incident.status === 'needs_human') return 'A repository investigation and fix will be attempted when the failure is observed again.';
  return 'The controller is collecting evidence before taking action.';
}

function decisionSummary(incident: Incident) {
  if (rolledBack(incident) && incident.decision === 'fix_pr') return 'Rolled back, then fix PR';
  if (rolledBack(incident) && incident.status === 'remediating') return 'Rolled back, fix in progress';
  return incident.decision ? decisionLabels[incident.decision] : 'Pending';
}

function IncidentCard({ incident, selected, onSelect }: { incident: Incident; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`incident-card${selected ? ' selected' : ''}`} onClick={onSelect} type="button">
      <span className="card-topline"><span>{formatDate(incident.detectedAt)}</span><StatusPill status={incident.status} /></span>
      <strong>{kindLabels[incident.kind]}</strong>
      <span className="card-meta">{decisionSummary(incident)} · {shortSha(incident.commitSha)} · {incident.probePath ?? 'build'}</span>
      <span className="card-summary">{incident.events.at(-1)?.message ?? incident.evidence[0] ?? 'No evidence recorded.'}</span>
    </button>
  );
}

function Evidence({ incident }: { incident: Incident }) {
  return <section className="panel evidence-panel">
    <div className="section-heading"><h2>Evidence</h2><span>{incident.evidence.length} entries</span></div>
    <ul className="evidence-list">{incident.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
  </section>;
}

function Timeline({ events }: { events: Incident['events'] }) {
  return <section className="panel timeline-panel">
    <div className="section-heading"><h2>Incident timeline</h2><span>chronological record</span></div>
    <ol className="timeline">
      {events.map((event, index) => <li key={`${event.at}-${event.type}-${index}`}>
        <span className="timeline-dot" aria-hidden="true" />
        <div><div className="timeline-meta"><strong>{event.type.replaceAll('_', ' ')}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div><p>{event.message}</p></div>
      </li>)}
    </ol>
  </section>;
}

function LiveActivity({ incidentId }: { incidentId: string }) {
  const [selectedRunId, setSelectedRunId] = useState('');
  const { run, runs, events, error } = useActivity(mode, incidentId, selectedRunId);
  const live = run?.status === 'queued' || run?.status === 'running';
  useEffect(() => setSelectedRunId(''), [incidentId]);
  return <section className="panel activity-panel">
    <div className="section-heading">
      <h2>Agent transcript</h2>
      {run
        ? <span className={`run-badge ${live ? 'live' : run.status}`}>
            {live && <span className="pulse" aria-hidden="true" />}
            {run.source === 'ai' ? 'AI run' : 'Rehearsal'} · {runStatusLabels[run.status]}
          </span>
        : <span>no run yet</span>}
    </div>
    {error && <p className="activity-error" role="status">{error}</p>}
    {!run && <p className="activity-empty">
      {mode === 'fixtures'
        ? 'Fixture data only. Run the local controller to watch an agent work.'
        : 'No saved agent log for this incident yet. The log stays after the sandbox finishes.'}
    </p>}
    {run && <>
      <div className="transcript-run-picker"><label>Run <select value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)}>
        <option value="">Latest run</option>
        {runs.map(candidate => <option key={candidate.id} value={candidate.id}>{formatDate(candidate.startedAt)} · {runStatusLabels[candidate.status]}</option>)}
      </select></label><span>{run.id}</span></div>
      <p className="activity-now" role="status">{events.at(-1)?.message.split('\n')[0] ?? 'Waiting for the first progress event.'}</p>
      <p className="transcript-note">Agent messages and tool details are saved with this run. Credentials are redacted; private internal reasoning is excluded.</p>
      <AgentTranscript key={run.id} events={events} run={run} />
      {run.outcome && <p className="activity-outcome">{run.outcome}</p>}
    </>}
  </section>;
}

type WatchLog = {
  id: string;
  level: string;
  message: string;
  statusCode?: number;
  timestamp: number;
  isError: boolean;
};

function WatchTelemetry({ watch }: { watch: WatchState | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const probe = watch?.probe;
  const logs = watch?.logs ?? [];
  const deployment = watch?.deployment ?? null;
  const probeEvery = everyLabel(watch?.intervalMs ?? 30_000);
  const logsEvery = everyLabel(watch?.logsIntervalMs ?? 60_000);
  const nextProbe = nextIn(watch?.checkedAt, watch?.intervalMs ?? 30_000, now);
  const nextLogs = nextIn(watch?.logsCheckedAt, watch?.logsIntervalMs ?? 60_000, now);
  return <section className="panel telemetry-panel" aria-live="polite">
    <div className="section-heading">
      <h2>Production telemetry</h2>
      <span>probe / {probeEvery} · logs / {logsEvery}</span>
    </div>
    <div className="telemetry-probe">
      <div>
        <span className="telemetry-label">Latest probe</span>
        <strong className={`probe-result ${probe?.result ?? 'unknown'}`}>
          {probe?.result === 'pass' ? 'Succeeded' : probe?.result === 'fail' ? 'Failed' : 'Waiting'}
        </strong>
      </div>
      <div>
        <span className="telemetry-label">Response</span>
        <strong className="mono">{probe?.statusCode ? `HTTP ${probe.statusCode}` : '—'}</strong>
      </div>
      <div>
        <span className="telemetry-label">Checked</span>
        <strong>{probe ? formatTime(probe.checkedAt) : '—'}</strong>
      </div>
      <div>
        <span className="telemetry-label">Next probe</span>
        <strong>{nextProbe}</strong>
      </div>
    </div>
    {probe?.result === 'fail' && <p className="probe-error">{probe.evidence}</p>}
    <div className="log-heading">
      <strong>Vercel {watch?.logsSource === 'deployment-events' ? 'deployment events' : 'runtime logs'}{deployment ? <span className="mono log-deployment">{shortDeployment(deployment.id)}</span> : null}</strong>
      <span>{watch?.logsCheckedAt ? `Updated ${formatTime(watch.logsCheckedAt)} · next ${nextLogs}` : 'Waiting for first log pull'}</span>
    </div>
    {watch?.logsSource === 'deployment-events' && <p className="log-fallback-note">Runtime logs are unavailable on this Vercel plan, so the build and deployment events of the same deployment are shown.</p>}
    {watch?.logsError && <p className="telemetry-error" role="status">{watch.logsError}</p>}
    {!watch && <p className="telemetry-empty">Live telemetry appears when the controller is running.</p>}
    {watch && !watch.logsError && logs.length === 0 && <p className="telemetry-empty">No runtime logs returned for the current deployment.</p>}
    {logs.length > 0 && <ol className="runtime-logs">
      {logs.map(log => <li key={log.id} className={log.isError ? 'runtime-log-error' : ''}>
        <time dateTime={new Date(log.timestamp).toISOString()}>{formatTime(new Date(log.timestamp).toISOString())}</time>
        <span className="runtime-log-level">{log.level}</span>
        {log.statusCode !== undefined && <span className="runtime-log-status">HTTP {log.statusCode}</span>}
        <p>{log.message}</p>
      </li>)}
    </ol>}
  </section>;
}

function Overview({ watch }: { watch: WatchState | null }) {
  return <main className="detail overview">
    <div className="overview-hero">
      <span className="empty-icon" aria-hidden="true">K</span>
      <h1>No incident selected</h1>
      <p>Production is quiet. The latest probe and the current production deployment&apos;s Vercel runtime logs stay visible below; when the controller records an incident, its evidence and recovery path open here.</p>
    </div>
    <WatchTelemetry watch={watch} />
  </main>;
}

function Detail({ incident, watch }: { incident: Incident; watch: WatchState | null }) {
  const actionLabel = incident.decision === 'fix_pr' ? 'Open pull request' : incident.decision === 'rollback' ? 'View rollback target' : 'View action';
  const detected = incident.events.find(event => event.type === 'detected');
  const decision = incident.events.find(event => event.type === 'decision');
  return <main className="detail">
    <div className="detail-heading">
      <div><p className="eyebrow">Incident {incident.id}</p><h1>{kindLabels[incident.kind]}</h1><p className="muted">Detected {formatDate(incident.detectedAt)} · {incident.projectId}</p></div>
      <StatusPill status={incident.status} />
    </div>
    <section className="trigger" aria-label="What triggered this incident">
      <div>
        <span className="eyebrow">What triggered this</span>
        <h2>{detected?.message ?? incident.evidence[0] ?? 'The controller recorded a failure.'}</h2>
        <p>{incident.probePath ? `Probe ${incident.probePath}` : 'Deployment status check'}{incident.deploymentUrl ? ` on ${hostOf(incident.deploymentUrl)}` : ''}.</p>
      </div>
      <ul>
        {incident.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        {decision && <li>{decision.message}</li>}
      </ul>
    </section>
    <section className="signal-grid" aria-label="Incident summary">
      <div><span>Decision</span><strong>{decisionSummary(incident)}</strong></div>
      <div><span>Revision</span><strong className="mono">{incident.commitSha ?? '—'}</strong></div>
      <div><span>Probe route</span><strong className="mono">{incident.probePath ?? 'Build status'}</strong></div>
      <div><span>Production host</span><strong className="mono">{hostOf(incident.deploymentUrl)}</strong></div>
      <div><span>Previous host</span><strong className="mono">{hostOf(incident.previousDeploymentUrl)}</strong></div>
      <div><span>Timeline</span><strong>{incident.events.length} events</strong></div>
    </section>
    <section className="action-banner">
      <div><span className="eyebrow">Current action</span><h2>{decisionSummary(incident)}</h2><p>{actionSummary(incident)}</p></div>
      {incident.actionUrl && <a className="action-link" href={incident.actionUrl} target="_blank" rel="noreferrer">{actionLabel}</a>}
    </section>
    {rolledBack(incident) && <ol className="rollback-steps">
      <li>Rollback — production moved back to the previous deploy.</li>
      <li>{incident.status === 'pr_opened' ? 'Fix — a pull request is open for that bad commit.' : incident.status === 'remediation_failed' ? 'Fix — the latest attempt failed; see the timeline for details.' : incident.status === 'needs_human' ? 'Fix — waiting for the next automatic attempt.' : 'Fix — the agent is working on the bad commit.'}</li>
    </ol>}
    {(incident.decision === 'rollback' || rolledBack(incident)) && <p className="caveat">{rollbackCaveat}</p>}
    <WatchTelemetry watch={watch} />
    <LiveActivity incidentId={incident.id} />
    <div className="detail-columns"><Evidence incident={incident} /><Timeline events={incident.events} /></div>
  </main>;
}

type WatchState = {
  checkedAt: string | null;
  outcome: string;
  detail: string;
  probePath: string;
  intervalMs: number;
  logsIntervalMs?: number;
  failures?: number;
  rollbackEnabled?: boolean;
  probe: { checkedAt: string; result: 'pass' | 'fail' | 'unknown'; evidence: string; statusCode?: number } | null;
  logs: WatchLog[];
  logsCheckedAt: string | null;
  logsError: string | null;
  logsSource?: 'runtime-logs' | 'deployment-events' | null;
  deployment?: { id: string; url: string; createdAt: string } | null;
};

function checkLabel(watch: WatchState | null) {
  const failures = watch?.failures ?? 0;
  if (!watch || watch.outcome === 'starting') return 'Waiting for the first check';
  if (watch.outcome === 'healthy') return 'Production is up';
  if (watch.outcome === 'failing') return watch.failures == null ? 'Production is failing' : `Failing ${failures} of 3`;
  if (watch.outcome === 'incident') return 'Incident open';
  return 'Check did not finish';
}

function LiveWatch({ onWatch }: { onWatch?: (watch: WatchState) => void }) {
  const [clock, setClock] = useState(() => new Date());
  const [watch, setWatch] = useState<WatchState | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (mode === 'fixtures') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/watch', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: abort.signal });
        if (response.ok) {
          const next = await response.json() as WatchState;
          setWatch(next);
          onWatch?.(next);
        }
      } catch { /* the next tick retries */ }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const checked = watch?.checkedAt ? new Date(watch.checkedAt) : null;
  const age = checked ? Math.max(0, Math.round((clock.getTime() - checked.getTime()) / 1000)) : null;
  const probeNext = nextIn(watch?.checkedAt, watch?.intervalMs ?? 30_000, clock);
  const logsNext = nextIn(watch?.logsCheckedAt, watch?.logsIntervalMs ?? 60_000, clock);
  const time = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <div className={`live-watch ${watch?.outcome ?? 'starting'}`} aria-live="polite">
    <strong className="live-clock">{time}</strong>
    {mode === 'fixtures'
      ? <span>Rehearsal data · local clock only</span>
      : <span>{checkLabel(watch)}{watch?.probePath ? ` · ${watch.probePath}` : ''}{age !== null ? ` · ${age}s ago` : ''}{watch?.checkedAt ? ` · next probe ${probeNext}` : ''}{watch?.logsCheckedAt ? ` · next logs ${logsNext}` : ''}</span>}
  </div>;
}

function FailureStreak({ watch }: { watch: WatchState | null }) {
  const known = typeof watch?.failures === 'number';
  const failures = watch?.outcome === 'healthy' ? 0 : Math.max(0, Math.min(watch?.failures ?? 0, 3));
  const note = !watch || watch.outcome === 'starting'
    ? 'Waiting for the first check.'
    : watch.outcome === 'incident'
      ? 'Three failures recorded. The incident is open.'
      : watch.outcome === 'unavailable'
        ? 'The last check did not finish.'
        : !known
          ? 'Failure count arrives after the controller redeploy.'
          : failures === 0
            ? 'Production passed. The streak is clear.'
            : `${failures} of 3 failures. The third starts the rollback or the fix.`;
  return <section className="streak" aria-label="Consecutive production failures">
    <div>
      <p className="eyebrow">Failure streak</p>
      <strong>{known || watch?.outcome === 'healthy' ? `${failures} / 3` : '—'}</strong>
      <span>{note}</span>
    </div>
    <ol>
      {[1, 2, 3].map(step => <li key={step} className={failures >= step ? 'hit' : ''}>
        <span>Fail {step}</span>
        <em>{failures >= step ? 'Failed' : 'Clear'}</em>
      </li>)}
    </ol>
  </section>;
}

function Dashboard() {
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const snapshot = useIncidents(mode, selectedId, refresh);
  const selected = snapshot.detail ?? snapshot.incidents[0] ?? null;
  const counts = useMemo(() => ({ active: snapshot.incidents.filter(item => !['recovered', 'needs_human', 'remediation_failed', 'pr_opened'].includes(item.status)).length, recovered: snapshot.incidents.filter(item => item.status === 'recovered').length }), [snapshot.incidents]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img className="brand-logo" src="/logo.png" alt="Sentinel logo" /><span>Sentinel <em>deploy watch</em></span></div><div className="topbar-meta"><LiveWatch onWatch={setWatch} /><span className={`mode-dot ${mode}`} />{mode === 'fixtures' ? 'Rehearsal data' : 'Live controller'}<button className="refresh" onClick={() => setShowSetup(value => !value)} type="button">Setup</button><button className="refresh" onClick={() => setRefresh(value => value + 1)} type="button">Refresh</button></div></header>
    <FailureStreak watch={watch} />
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><div><p className="eyebrow">Operations</p><h2>Incidents</h2></div><span className="count">{snapshot.incidents.length}</span></div><div className="sidebar-stats"><span><strong>{counts.active}</strong> active</span><span><strong>{counts.recovered}</strong> recovered</span></div>
        {snapshot.loading && <p className="state-message">Loading incident evidence…</p>}
        {snapshot.error && <div className="error-box" role="alert"><strong>Controller unavailable</strong><p>{snapshot.error}</p><button onClick={() => setRefresh(value => value + 1)} type="button">Try again</button></div>}
        {!snapshot.loading && !snapshot.error && snapshot.incidents.length === 0 && <p className="state-message">No incidents recorded yet.</p>}
        <nav className="incident-list" aria-label="Incidents">{snapshot.incidents.map(incident => <IncidentCard key={incident.id} incident={incident} selected={selected?.id === incident.id} onSelect={() => setSelectedId(incident.id)} />)}</nav>
      </aside>
      {showSetup ? <Setup onClose={() => setShowSetup(false)} /> : selected ? <Detail incident={selected} watch={watch} /> : <Overview watch={watch} />}
    </div>
  </div>;
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) { setError('Invalid username or password.'); return; }
      onAuthenticated();
    } catch { setError('The controller is unavailable. Start it and try again.'); }
    finally { setBusy(false); }
  }

  return <main className="login-shell"><form className="login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.png" alt="Sentinel logo" /><p className="eyebrow">Sentinel deploy watch</p><h1>Sign in to the incident desk</h1>
    <p className="login-note">Use the local dashboard credentials configured in the controller environment.</p>
    <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label>
    <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
    {error && <p className="login-error" role="alert">{error}</p>}
    <button className="action" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}

function AuthenticatedApp() {
  const [authenticated, setAuthenticated] = useState(mode === 'fixtures' ? true : false);
  const [checking, setChecking] = useState(mode !== 'fixtures');
  useEffect(() => {
    if (mode === 'fixtures') return;
    void fetch('/api/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(response => { if (response.ok) setAuthenticated(true); })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  if (checking) return <main className="login-shell"><p className="muted">Checking dashboard session…</p></main>;
  return authenticated ? <Dashboard /> : <Login onAuthenticated={() => setAuthenticated(true)} />;
}

export default function App() {
  return <AuthenticatedApp />;
}
