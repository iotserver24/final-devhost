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
  const [renderLogin, setRenderLogin] = useState<VercelConnect>(null);
  const [renderOwners, setRenderOwners] = useState<{ id: string; name: string }[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [projects, setProjects] = useState<{ id: string; name: string; domains: string[]; teamId?: string }[]>([]);
  const [deployments, setDeployments] = useState<{ id: string; url: string; state: string; createdAt: string; ref: string; sha: string }[]>([]);
  const [monitorNote, setMonitorNote] = useState('');
  const [githubListNote, setGithubListNote] = useState('Repository list has not loaded.');
  const [vercelListNote, setVercelListNote] = useState('Project list has not loaded.');
  const [services, setServices] = useState<{ id: string; name: string; repository: string; role: string; probePath: string; enabled: boolean }[]>([]);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceMessage, setServiceMessage] = useState('');
  const [serviceDraft, setServiceDraft] = useState({ name: '', repository: '', vercelProjectId: '', productionHost: '', probePath: '/api/tasks', role: 'app' });

  const loadServices = useCallback(async () => {
    const response = await fetch('/api/watched-services', { credentials: 'same-origin' });
    if (!response.ok) { setServiceMessage('Could not load services. Try refreshing.'); return; }
    const body = await response.json() as { services?: { id: string; name: string; repository: string; role: string; probePath: string; enabled: boolean }[] };
    setServices(body.services ?? []);
  }, []);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 401) throw new Error('Sign in again. The controller rejected this session.');
      if (response.status === 403) throw new Error('This account cannot open integration settings. Sign in with the administrator account, not the viewer account.');
      throw new Error(body.error || `The controller did not return integration settings (HTTP ${response.status}).`);
    }
    const body = await response.json() as { fields: SettingField[] };
    setFields(body.fields);
    setDraft(current => Object.fromEntries(body.fields.map(field => [field.key, current[field.key] ?? (field.secret ? '' : field.value)])));
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadSettings(abort.signal).catch(reason => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.');
    });
    void loadServices();
    return () => abort.abort();
  }, [loadSettings, loadServices]);

  const field = useMemo(() => new Map(fields.map(item => [item.key, item])), [fields]);
  const githubReady = Boolean(field.get('GITHUB_INSTALLATION_ID')?.configured);
  const repoMatches = repos.filter(repo => repo.toLowerCase().includes(repoQuery.trim().toLowerCase()));
  const visibleRepos = repoQuery.trim() ? repoMatches.slice(0, 12) : [];
  const vercelReady = Boolean(field.get('VERCEL_ACCESS_TOKEN')?.configured);
  const botSlug = field.get('GITHUB_APP_SLUG')?.value || 'not configured';
  const monitorOn = field.get('CONTROLLER_MONITOR_ENABLED')?.value === 'true';

  useEffect(() => {
    if (!fields.length) return;
    if (!githubReady) { setGithubListNote('GitHub access is not connected, so there is no repository list.'); return; }
    const abort = new AbortController();
    const query = repoQuery.trim();
    void fetch(`/api/github/repos${query ? `?q=${encodeURIComponent(query)}` : ''}`, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as { repositories?: string[]; total?: number; error?: string };
        if (!response.ok) { setGithubListNote(body.error || `Repository list failed (${response.status}).`); return; }
        const names = body.repositories ?? [];
        setRepos(names);
        const total = body.total ?? names.length;
        setGithubListNote(total ? `${total} repositories from the bot install.` : 'The bot is connected and has no repositories.');
      })
      .catch(() => { if (!abort.signal.aborted) setGithubListNote('Repository list did not load.'); });
    return () => abort.abort();
  }, [fields.length, githubReady, repoQuery]);

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

  useEffect(() => {
    const projectId = draft.VERCEL_PROJECT_ID;
    if (!projectId || !vercelReady) { setDeployments([]); return; }
    const abort = new AbortController();
    void fetch(`/api/vercel/deployments?projectId=${encodeURIComponent(projectId)}`, { headers: { Accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as { deployments?: { id: string; url: string; state: string; createdAt: string; ref: string; sha: string }[] };
        if (!abort.signal.aborted) setDeployments(body.deployments ?? []);
      })
      .catch(() => { if (!abort.signal.aborted) setDeployments([]); });
    return () => abort.abort();
  }, [draft.VERCEL_PROJECT_ID, vercelReady]);
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

  async function addService(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServiceBusy(true);
    setServiceMessage('');
    try {
      const response = await fetch('/api/watched-services', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serviceDraft) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'Could not add the service. Check the details and try again.');
      }
      setServiceDraft({ name: '', repository: '', vercelProjectId: '', productionHost: '', probePath: '/api/tasks', role: 'app' });
      await loadServices();
      setServiceMessage('Service added.');
    } catch (reason) {
      setServiceMessage(reason instanceof Error ? reason.message : 'Could not add the service.');
    } finally { setServiceBusy(false); }
  }

  async function removeService(id: string) {
    setServiceMessage('');
    try {
      const response = await fetch(`/api/watched-services?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not remove the service. Try again.');
      await loadServices();
      setServiceMessage('Service removed.');
    } catch (reason) {
      setServiceMessage(reason instanceof Error ? reason.message : 'Could not remove the service.');
    }
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

  async function connectRender() {
    setError('');
    try {
      const started = await fetch('/api/render/connect', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!started.ok) throw new Error('Render sign-in did not start.');
      const body = await started.json() as { userCode: string; verificationUri: string; intervalMs: number };
      setRenderLogin({ userCode: body.userCode, verificationUri: body.verificationUri, status: 'Waiting for approval in the Render dashboard.' });
      window.open(body.verificationUri, '_blank', 'noopener');
      const timer = window.setInterval(async () => {
        const poll = await fetch('/api/render/connect', { headers: { Accept: 'application/json' } });
        if (poll.status === 404) { window.clearInterval(timer); setError('Render sign-in expired. Start it again.'); return; }
        if (!poll.ok) return;
        const result = await poll.json() as { ok?: boolean; owners?: { id: string; name: string }[] };
        if (result.ok) {
          window.clearInterval(timer);
          setRenderOwners(result.owners ?? []);
          setRenderLogin(current => current ? { ...current, status: result.owners?.length === 1 ? 'Connected. Workspace saved.' : 'Connected. Choose the workspace.' } : current);
          await loadSettings();
        }
      }, Math.max(body.intervalMs, 5000));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Render sign-in did not start.');
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

  async function disconnect(provider: 'github' | 'vercel' | 'render') {
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
    if (provider === 'render') { setRenderLogin(null); setRenderOwners([]); }
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
        <h1>Setup</h1>
        <p className="setup-lede">Pick the repository, the Vercel project, and the deployment Sentinel should watch.</p>
      </div>
      <a className="button button-ghost" href="/">Incidents</a>
    </div>

    <section className="setup-hero services-panel" aria-labelledby="services-title">
      <div className="services-heading">
        <div>
          <h2 id="services-title">Watched services</h2>
          <p>Manage the applications and dependencies Sentinel monitors.</p>
        </div>
        <button className="button button-secondary services-refresh" type="button" onClick={() => void loadServices()}>Refresh list</button>
      </div>

      <div className="services-inventory">
        <div className="services-inventory-heading"><span>Service inventory</span><span>{services.length} {services.length === 1 ? 'service' : 'services'}</span></div>
        {services.length > 0 ? <ul className="service-list">{services.map(service => <li className="service-row" key={service.id}>
          <div className="service-identity"><span className="service-indicator" aria-hidden="true" /><div><strong>{service.name}</strong><span>{service.repository}</span></div></div>
          <div className="service-details"><span className="service-role">{service.role}</span><code>{service.probePath}</code></div>
          <button className="service-remove" type="button" aria-label={`Remove ${service.name}`} onClick={() => void removeService(service.id)}>Remove</button>
        </li>)}</ul> : <p className="services-empty">No extra services yet. The current saved target is added when the controller starts.</p>}
      </div>

      <form className="service-form" onSubmit={event => void addService(event)}>
        <div className="service-form-heading"><div><h3>Add a service</h3><p>Connect a repository to its Vercel project and production endpoint.</p></div></div>
        <div className="service-form-grid">
          <label className="setup-field"><span>Name</span><input required value={serviceDraft.name} placeholder="e.g. API" onChange={event => setServiceDraft({ ...serviceDraft, name: event.target.value })} /></label>
          <label className="setup-field"><span>Repository</span><input required value={serviceDraft.repository} placeholder="owner/repository" onChange={event => setServiceDraft({ ...serviceDraft, repository: event.target.value })} /></label>
          <label className="setup-field"><span>Vercel project ID</span><input required value={serviceDraft.vercelProjectId} placeholder="prj_..." onChange={event => setServiceDraft({ ...serviceDraft, vercelProjectId: event.target.value })} /></label>
          <label className="setup-field"><span>Production host</span><input required value={serviceDraft.productionHost} placeholder="example.com" onChange={event => setServiceDraft({ ...serviceDraft, productionHost: event.target.value })} /></label>
          <label className="setup-field"><span>Probe path</span><input required value={serviceDraft.probePath} onChange={event => setServiceDraft({ ...serviceDraft, probePath: event.target.value })} /></label>
          <label className="setup-field"><span>Role</span><select value={serviceDraft.role} onChange={event => setServiceDraft({ ...serviceDraft, role: event.target.value })}><option value="app">Application</option><option value="dependency">Dependency</option></select></label>
        </div>
        <div className="service-form-actions"><p>Each service is monitored separately.</p><button className="button button-primary" disabled={serviceBusy} type="submit">{serviceBusy ? 'Adding…' : 'Add service'}</button></div>
        {serviceMessage && <p className="service-message" role="status">{serviceMessage}</p>}
      </form>
    </section>

    <section className="setup-hero" aria-labelledby="render-title">
      <div className="setup-hero-copy">
        <div>
          <h2 id="render-title">Render</h2>
          <p>Same device login as the Render CLI. The token is what logs and rollback already send as a bearer.</p>
          {renderLogin && <p className="connect-status"><strong>{renderLogin.status}</strong> Code <code>{renderLogin.userCode}</code> · <a href={renderLogin.verificationUri} target="_blank" rel="noreferrer">open Render</a></p>}
          {renderOwners.length > 1 && <ul>{renderOwners.map(owner => <li key={owner.id}><button type="button" onClick={() => void choose('RENDER_OWNER_ID', owner.id)}>{owner.name}</button></li>)}</ul>}
        </div>
      </div>
      <div className="setup-hero-actions">
        <button className="button button-primary" type="button" onClick={() => void connectRender()}>Connect Render</button>
        <button className="button button-ghost" type="button" onClick={() => void disconnect('render')}>Disconnect</button>
      </div>
    </section>
    <p className="setup-note">Railway and Coolify still take a pasted token below. Render can use Connect Render instead. Set the public production URL and service id, then restart Sentinel. Logs attach to the incident. Rollback stays off until you turn it on.</p>

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
      <div className="repo-results">
        <span>{draft.REMEDIATOR_REPOSITORY ? `Selected: ${draft.REMEDIATOR_REPOSITORY}` : 'No repository selected.'}</span>
        {!repoQuery.trim() && <p>Type part of the name. {repos.length} repositories are loaded from the bot install.</p>}
        {repoQuery.trim() && visibleRepos.length === 0 && <p>No loaded repository matches that name. The bot only lists repositories it was granted.</p>}
        {visibleRepos.length > 0 && <ul>
          {visibleRepos.map(repo => <li key={repo}><button type="button" className={repo === draft.REMEDIATOR_REPOSITORY ? 'selected' : ''} onClick={() => void choose('REMEDIATOR_REPOSITORY', repo)}>{repo}</button></li>)}
        </ul>}
        {repoQuery.trim() && repoMatches.length > visibleRepos.length && <p>Showing {visibleRepos.length} of {repoMatches.length}. Keep typing to narrow the list.</p>}
      </div>
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
        <label className="setup-field">
          <span>Deployment for this project</span>
          <select value={deployments.some(item => item.id === draft.CONTROLLER_WATCH_DEPLOYMENT_ID) ? draft.CONTROLLER_WATCH_DEPLOYMENT_ID : ''} onChange={event => { void choose('CONTROLLER_WATCH_DEPLOYMENT_ID', event.target.value); }}>
            <option value="">{deployments.length ? 'Choose a deployment' : 'No deployments loaded'}</option>
            {deployments.map(item => <option key={item.id} value={item.id}>{item.state} · {item.ref || 'no branch'} · {item.sha || item.id.slice(0, 8)} · {item.url}</option>)}
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
