import { useCallback, useEffect, useMemo, useState } from 'react';

interface SettingField {
  group: string;
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: 'saved' | 'environment' | 'missing';
  value: string;
}

type VercelConnect = { userCode: string; verificationUri: string; status: string } | null;

function productionHost(domains: string[]): string {
  const hosts = domains.filter(domain => domain && !domain.includes('*'));
  const own = hosts.find(domain => !domain.endsWith('.vercel.app'));
  if (own) return own;
  return hosts.filter(domain => domain.endsWith('.vercel.app')).sort((a, b) => a.length - b.length)[0] ?? '';
}

export function Setup({ onClose }: { onClose: () => void }) {
  const [fields, setFields] = useState<SettingField[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [vercel, setVercel] = useState<VercelConnect>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string; domains: string[]; teamId?: string }[]>([]);
  const [monitorNote, setMonitorNote] = useState('');
  const [githubListNote, setGithubListNote] = useState('Repository list has not loaded.');
  const [vercelListNote, setVercelListNote] = useState('Project list has not loaded.');

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/settings', { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error('The controller did not return integration settings.');
    const body = await response.json() as { fields: SettingField[] };
    setFields(body.fields);
    setDraft(current => Object.fromEntries(body.fields.map(field => [field.key, current[field.key] ?? (field.secret ? '' : field.value)])));
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadSettings(abort.signal).catch(reason => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.');
    });
    return () => abort.abort();
  }, [loadSettings]);

  const field = useMemo(() => new Map(fields.map(item => [item.key, item])), [fields]);
  const githubReady = Boolean(field.get('GITHUB_INSTALLATION_ID')?.configured);
  const vercelReady = Boolean(field.get('VERCEL_ACCESS_TOKEN')?.configured);
  const botSlug = field.get('GITHUB_APP_SLUG')?.value || 'not configured';
  const monitorOn = field.get('CONTROLLER_MONITOR_ENABLED')?.value === 'true';

  useEffect(() => {
    if (!fields.length) return;
    if (!githubReady) { setGithubListNote('GitHub access is not connected, so there is no repository list.'); return; }
    const abort = new AbortController();
    void fetch('/api/github/repos', { headers: { Accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as { repositories?: string[]; error?: string };
        if (!response.ok) { setGithubListNote(body.error || `Repository list failed (${response.status}).`); return; }
        const names = body.repositories ?? [];
        setRepos(names);
        setGithubListNote(names.length ? `${names.length} repositories from the bot install.` : 'The bot is connected and has no repositories.');
      })
      .catch(() => { if (!abort.signal.aborted) setGithubListNote('Repository list did not load.'); });
    return () => abort.abort();
  }, [fields.length, githubReady]);

  useEffect(() => {
    if (!fields.length) return;
    if (!vercelReady) { setVercelListNote('Vercel is not connected, so there is no project list.'); return; }
    const abort = new AbortController();
    void fetch('/api/vercel/projects', { headers: { Accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as { projects?: { id: string; name: string; domains: string[]; teamId?: string }[]; selected?: string | null; error?: string };
        if (!response.ok) { setVercelListNote(body.error || `Project list failed (${response.status}).`); return; }
        const listed = body.projects ?? [];
        setProjects(listed);
        setVercelListNote(listed.length ? `${listed.length} Vercel projects.` : 'Vercel is connected and returned no projects.');
        if (body.selected) setDraft(current => ({ ...current, VERCEL_PROJECT_ID: current.VERCEL_PROJECT_ID || body.selected || '' }));
      })
      .catch(() => { if (!abort.signal.aborted) setVercelListNote('Project list did not load.'); });
    return () => abort.abort();
  }, [fields.length, vercelReady]);
  const groups = [...new Set(fields.map(item => item.group).filter(group => group !== 'Vercel'))];
  const setValue = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value }));

  function renderField(key: string, className = '') {
    const item = field.get(key);
    if (!item) return null;
    return <label className={`setup-field ${className}`} key={item.key}>
      <span>{item.label}</span>
      <input
        type={item.secret ? 'password' : 'text'}
        autoComplete={item.secret ? 'new-password' : 'off'}
        placeholder={item.configured ? `Configured from ${item.source}` : 'Not set'}
        value={draft[item.key] ?? ''}
        onChange={event => setValue(item.key, event.target.value)}
      />
      {item.configured && <small>Configured · value hidden</small>}
    </label>;
  }

  async function connectVercel() {
    setError('');
    try {
      const started = await fetch('/api/vercel/connect', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!started.ok) throw new Error('Vercel sign-in did not start.');
      const body = await started.json() as { userCode: string; intervalMs: number };
      const verificationUri = `https://vercel.com/oauth/device?user_code=${encodeURIComponent(body.userCode)}`;
      setVercel({ userCode: body.userCode, verificationUri, status: 'Waiting for approval.' });
      window.open(verificationUri, '_blank', 'noopener');
      const timer = window.setInterval(async () => {
        const poll = await fetch('/api/vercel/connect', { headers: { Accept: 'application/json' } });
        if (poll.status === 404) { window.clearInterval(timer); setError('Vercel sign-in expired. Start it again.'); return; }
        if (!poll.ok) return;
        const result = await poll.json() as { ok?: boolean };
        if (result.ok) {
          window.clearInterval(timer);
          setVercel(current => current ? { ...current, status: 'Connected. Save or restart the controller to apply it.' } : current);
          await loadSettings();
        }
      }, Math.max(body.intervalMs, 5000));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Vercel sign-in did not start.');
    }
  }

  async function choose(key: string, value: string, extra?: Record<string, string>) {
    setValue(key, value);
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ values: { [key]: value, ...extra } }),
    });
    if (!response.ok) setError('That choice was not saved.');
    else await loadSettings();
  }

  async function disconnect(provider: 'github' | 'vercel') {
    setError('');
    const response = await fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setError(body.error || 'Disconnect did not finish.'); return; }
    if (provider === 'github') { setRepos([]); setGithubListNote('GitHub access was disconnected.'); }
    if (provider === 'vercel') { setProjects([]); setVercel(null); setVercelListNote('Vercel was disconnected.'); setMonitorNote('Monitor stopped.'); }
    setDraft(current => ({ ...current, ...(provider === 'github' ? { REMEDIATOR_REPOSITORY: '' } : { VERCEL_PROJECT_ID: '' }) }));
    await loadSettings();
  }

  async function startMonitor() {
    setError('');
    setMonitorNote('');
    const response = await fetch('/api/monitor/start', { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({})) as { error?: string; already?: boolean; started?: boolean };
    if (!response.ok) { setError(body.error || 'The monitor did not start.'); return; }
    setMonitorNote(body.already ? 'Monitor is already running.' : 'Monitor started.');
    await loadSettings();
  }

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const values = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ values }),
      });
      if (!response.ok) throw new Error('Settings were not saved.');
      setMessage('Saved securely in the controller database. Restart the controller to apply monitoring changes.');
      await loadSettings();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Settings were not saved.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="detail setup">
    <div className="setup-header">
      <div>
        <p className="eyebrow">Control room / configuration</p>
        <h1>Connect your stack</h1>
        <p className="setup-lede">Give Sentinel the smallest set of credentials it needs to watch one Vercel project and report evidence here.</p>
      </div>
      <button className="button button-ghost" type="button" onClick={onClose}>Back to incidents</button>
    </div>

    <p className="setup-note">Railway, Render, and Coolify use scoped API tokens below. Select the active platform, provide its public production URL and service/application ID, then restart Sentinel. Deployment logs are attached to incident evidence and rollback remains opt-in.</p>

    {error && <div className="error-box" role="alert"><strong>Setup needs attention</strong><p>{error}</p></div>}

    <section className="setup-connection-row">
      <div>
        <div className="provider-mark provider-github" aria-hidden="true">GH</div>
        <div>
          <h2>GitHub bot</h2>
          <p className={githubReady ? 'connection-ok' : 'connection-off'}>{githubReady ? `GitHub connected · ${botSlug}` : 'GitHub not connected'}</p>
          {githubReady && <p>{githubListNote}</p>}
        </div>
      </div>
      <div className="setup-hero-actions">
        {field.get('GITHUB_APP_ID')?.configured
          ? <a className="button button-secondary" href="/api/github/connect">Give access</a>
          : <span className="connect-status">Bot is not configured on the controller.</span>}
        {githubReady && <button className="button button-ghost" type="button" onClick={() => void disconnect('github')}>Disconnect</button>}
      </div>
    </section>

    {githubReady && <section className="setup-hero">
      <div className="setup-hero-copy"><div><h2>Repository</h2><p>Choose the repo the bot can open pull requests on.</p></div></div>
      <label className="setup-field">
        <span>Search repositories</span>
        <input value={repoQuery} placeholder="owner/name" onChange={event => setRepoQuery(event.target.value)} />
      </label>
      <label className="setup-field">
        <span>Repository</span>
        <select value={repos.includes(draft.REMEDIATOR_REPOSITORY ?? '') ? draft.REMEDIATOR_REPOSITORY : ''} onChange={event => void choose('REMEDIATOR_REPOSITORY', event.target.value)}>
          <option value="">Choose a repository</option>
          {repos.filter(repo => repo.toLowerCase().includes(repoQuery.trim().toLowerCase())).map(repo => <option key={repo} value={repo}>{repo}</option>)}
        </select>
      </label>
    </section>}

    <section className="setup-hero" aria-labelledby="vercel-title">
      <div className="setup-hero-copy">
        <div className="provider-mark provider-vercel" aria-hidden="true">V</div>
        <div>
          <div className="section-kicker"><span className="status-dot status-dot-warn" /> Primary provider</div>
          <h2 id="vercel-title">Production link and Vercel</h2>
          <p className={vercelReady ? 'connection-ok' : 'connection-off'}>{vercelReady ? 'Vercel connected' : 'Vercel not connected'}</p>
          {vercelReady && <p>{vercelListNote} Paste the public site link and the matching project is selected.</p>}
        </div>
      </div>
      <div className="setup-hero-actions">
        <button className="button button-primary" type="button" onClick={() => void connectVercel()}>{vercelReady ? 'Vercel connected' : 'Connect Vercel'}</button>
        {vercelReady && <button className="button button-ghost" type="button" onClick={() => void disconnect('vercel')}>Disconnect</button>}
        {vercel && <div className="connect-status"><strong>{vercel.status}</strong><span>Code <code>{vercel.userCode}</code> · <a href={vercel.verificationUri} target="_blank" rel="noreferrer">open verification</a></span></div>}
      </div>
      {vercelReady && <>
        <label className="setup-field">
          <span>Vercel project</span>
          <select value={projects.some(project => project.id === draft.VERCEL_PROJECT_ID) ? draft.VERCEL_PROJECT_ID : ''} onChange={event => {
            const project = projects.find(item => item.id === event.target.value);
            const host = project ? productionHost(project.domains) : '';
            void choose('VERCEL_PROJECT_ID', event.target.value, {
              VERCEL_TEAM_ID: project?.teamId ?? '',
              ...(host ? { VERCEL_PRODUCTION_DOMAIN: host } : {}),
              CONTROLLER_PROBE_PATH: draft.CONTROLLER_PROBE_PATH || '/api/tasks',
            });
          }}>
            <option value="">Choose a project</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <div className="field-grid field-grid-2">
          {renderField('VERCEL_PRODUCTION_DOMAIN')}
          {renderField('CONTROLLER_PROBE_PATH')}
        </div>
        <div className="setup-hero-actions">
          <button className="button button-primary" type="button" onClick={() => void startMonitor()}>{monitorOn ? 'Monitor running' : 'Start monitor'}</button>
          {monitorNote && <p className="success-message" role="status">{monitorNote}</p>}
        </div>
      </>}
    </section>

    {groups.map(group => <section className="setup-advanced" key={group}>
      <div className="setup-advanced-heading"><div><p className="eyebrow">Optional</p><h2>{group}</h2></div><span>{fields.filter(item => item.group === group && item.configured).length} configured</span></div>
      <div className="field-grid field-grid-2">{fields.filter(item => item.group === group && item.key !== 'REMEDIATOR_REPOSITORY').map(item => renderField(item.key))}</div>
    </section>)}

    <div className="setup-footer">
      <div><strong>Changes are stored, then applied on restart.</strong><span>Secret values stay hidden after saving.</span></div>
      <button className="button button-primary" disabled={busy} type="button" onClick={() => void save()}>{busy ? 'Saving…' : 'Save configuration'}</button>
    </div>
    {message && <p className="success-message" role="status">{message}</p>}
  </main>;
}
