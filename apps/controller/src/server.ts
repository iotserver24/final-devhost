import { setDefaultResultOrder } from 'node:dns';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore } from './incident-store';
import { createIncidentApi } from './api';
import { ActivityHub } from './activity';
import { createActivityApi } from './activity-api';
import { dispatchRun } from './remediation';
import { startPollingWorker, type PollingWorker, type WatchTarget } from './worker';
import { ensureLegacyWatchedService, parseWatchedService, type WatchedService } from './services';
import { VercelProvider } from './vercel-provider';
import { CoolifyProvider, RailwayProvider, RenderProvider } from './platform-providers';
import { checkProject, runtimeLogSignal, type DeploymentProvider, type DeploymentSummary, type RuntimeLog } from './monitor';
import { createControllerActions, type RemediationConfig } from './actions';
import { applyStoredSettings, createSettingsApi } from './settings';
import { finishRemediation } from './monitor';
import { startLocalEngine, type LocalEngine } from './local-engine';
import { policyFromEnvironment } from './classify';
import { posthogFromEnvironment } from './posthog';
import { sentryFromEnvironment } from './sentry';
import { disconnectFields, exchangeGithubManifest, githubConnectTarget, githubCredentials, githubStateOk, installationExists, listInstallationRepositories, matchingVercelProject, verifyGithubWebhook } from './github-app';
import { pollVercelDevice, startVercelDevice } from './vercel-login';
import { DashboardAuth } from './auth';
import { AuditLog, RateLimiter, requiredRole, roleAllows } from './access';
import { DeliveryLedger, RunLock, readCommentWebhook, chooseStrategy, buildFollowupContext } from './pr-followup';

setDefaultResultOrder('ipv4first');

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL;
const store = new IncidentStore(databaseUrl);
await store.ready;
await applyStoredSettings(store);

function publicOrigin(): string {
  const configured = process.env.CONTROLLER_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (!configured) return `http://${host}:${port}`;
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CONTROLLER_PUBLIC_ORIGIN must be an http(s) origin without credentials.');
  }
  return url.origin;
}

const host = process.env.CONTROLLER_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('CONTROLLER_HOST must be 127.0.0.1 or 0.0.0.0.');
const port = Number(process.env.CONTROLLER_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTROLLER_PORT must be a valid TCP port.');
}

const monitorFlag = process.env.CONTROLLER_MONITOR_ENABLED ?? 'false';
const rollbackFlag = process.env.CONTROLLER_ROLLBACK_ENABLED ?? 'false';
const remediationFlag = process.env.CONTROLLER_REMEDIATION_ENABLED ?? 'false';
if (!['true', 'false'].includes(monitorFlag) || !['true', 'false'].includes(rollbackFlag)
  || !['true', 'false'].includes(remediationFlag)) {
  throw new Error('Controller enablement variables must be either true or false.');
}
if (rollbackFlag === 'true' && monitorFlag !== 'true') {
  throw new Error('Rollback cannot be enabled when monitoring is disabled.');
}

type MonitorConfig = {
  projectId: string;
  rollbackEnabled: boolean;
  probePath: string;
  pollIntervalMs: number;
  deploymentStatusIntervalMs: number;
  logsIntervalMs: number;
  provider: DeploymentProvider;
  platform: string;
};

function readMonitorConfig(): MonitorConfig {
  const platform = (process.env.CONTROLLER_PLATFORM ?? 'vercel').toLowerCase();
  if (!['vercel', 'railway', 'render', 'coolify'].includes(platform)) throw new Error('CONTROLLER_PLATFORM must be vercel, railway, render, or coolify.');
  const projectId = platform === 'vercel' ? process.env.VERCEL_PROJECT_ID : platform === 'railway' ? process.env.RAILWAY_SERVICE_ID : platform === 'render' ? process.env.RENDER_SERVICE_ID : process.env.COOLIFY_APPLICATION_ID;
  if (!projectId) throw new Error(`Monitoring requires a configured ${platform} service/application ID.`);
  const rollbackEnabled = process.env.CONTROLLER_ROLLBACK_ENABLED === 'true';
  if (rollbackEnabled) process.env.CONTROLLER_ROLLBACK_PROJECT_ID = projectId;
  const pollIntervalMs = Number(process.env.CONTROLLER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new Error('CONTROLLER_POLL_INTERVAL_MS must be between 1000 and 300000.');
  }
  const deploymentStatusIntervalMs = Number(process.env.CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS ?? 60_000);
  if (!Number.isInteger(deploymentStatusIntervalMs) || deploymentStatusIntervalMs < 1_000 || deploymentStatusIntervalMs > 600_000) {
    throw new Error('CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS must be between 1000 and 600000.');
  }
  const logsIntervalMs = Number(process.env.CONTROLLER_LOGS_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(logsIntervalMs) || logsIntervalMs < 30_000 || logsIntervalMs > 600_000) {
    throw new Error('CONTROLLER_LOGS_INTERVAL_MS must be between 30000 and 600000.');
  }
  const productionUrl = platform === 'vercel' ? process.env.VERCEL_PRODUCTION_DOMAIN : platform === 'railway' ? process.env.RAILWAY_PRODUCTION_URL : platform === 'render' ? process.env.RENDER_PRODUCTION_URL : process.env.COOLIFY_PRODUCTION_URL;
  if (!productionUrl) throw new Error(`Monitoring requires a ${platform} public production URL.`);
  let provider: DeploymentProvider;
  if (platform === 'vercel') {
    const token = process.env.VERCEL_ACCESS_TOKEN;
    if (!token) throw new Error('Vercel monitoring requires VERCEL_ACCESS_TOKEN.');
    provider = new VercelProvider({
      accessToken: token, projectId, productionDomain: productionUrl,
      teamId: process.env.VERCEL_TEAM_ID,
      // Overlap consecutive pulls so delayed ingestion can be picked up next time.
      runtimeLogWindowMs: logsIntervalMs + 30_000,
    });
  } else if (platform === 'railway') {
    const token = process.env.RAILWAY_TOKEN; const railwayProjectId = process.env.RAILWAY_PROJECT_ID;
    if (!token || !railwayProjectId) throw new Error('Railway monitoring requires RAILWAY_TOKEN and RAILWAY_PROJECT_ID.');
    provider = new RailwayProvider({ token, projectId: railwayProjectId, serviceId: projectId, environmentId: process.env.RAILWAY_ENVIRONMENT_ID, productionUrl });
  } else if (platform === 'render') {
    const token = process.env.RENDER_API_KEY; const ownerId = process.env.RENDER_OWNER_ID;
    if (!token || !ownerId) throw new Error('Render monitoring requires RENDER_API_KEY and RENDER_OWNER_ID.');
    provider = new RenderProvider({ accessToken: token, serviceId: projectId, ownerId, productionUrl });
  } else {
    const token = process.env.COOLIFY_API_TOKEN; const baseUrl = process.env.COOLIFY_BASE_URL;
    if (!token || !baseUrl) throw new Error('Coolify monitoring requires COOLIFY_API_TOKEN and COOLIFY_BASE_URL.');
    provider = new CoolifyProvider({ accessToken: token, applicationId: projectId, baseUrl, productionUrl });
  }
  return { projectId, rollbackEnabled, probePath: process.env.CONTROLLER_PROBE_PATH ?? '/api/tasks', pollIntervalMs, deploymentStatusIntervalMs, logsIntervalMs, provider, platform };
}

const monitorConfig = monitorFlag === 'true' ? readMonitorConfig() : undefined;

const dashboardAuth = new DashboardAuth(process.env.DASHBOARD_USERNAME ?? '', process.env.DASHBOARD_PASSWORD ?? '');
const loginLimiter = new RateLimiter(Number(process.env.CONTROLLER_LOGIN_RATE_LIMIT ?? 10), 5 * 60_000);
const actionLimiter = new RateLimiter(Number(process.env.CONTROLLER_ACTION_RATE_LIMIT ?? 30), 60_000);
const auditLog = new AuditLog(500);
const followupLedger = new DeliveryLedger(1_000);
const followupLock = new RunLock(30 * 60_000);

function clientKey(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
}
let remediation: RemediationConfig | undefined;
if (remediationFlag === 'true') {
  const required = ['REMEDIATOR_MODEL_ID', 'REMEDIATOR_MODEL_BASE_URL', 'REMEDIATOR_MODEL_API_KEY', 'E2B_REMEDIATOR_TEMPLATE'];
  const missing = required.filter(key => !process.env[key]);
  const githubAppReady = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PEM && process.env.GITHUB_INSTALLATION_ID);
  if (!process.env.GITHUB_READ_TOKEN && !githubAppReady) missing.push('GITHUB_READ_TOKEN or a connected GitHub app');
  if (!process.env.REMEDIATOR_REPOSITORY) missing.push('REMEDIATOR_REPOSITORY');
  if (missing.length) throw new Error(`Remediation requires configuration: ${missing.join(', ')}.`);
  const pathPrefix = `${(process.env.REMEDIATOR_ALLOWED_PATH_PREFIX?.trim() || 'apps/sample/').replace(/\/?$/, '/')}`;
  const standaloneSample = pathPrefix === 'src/';
  const fixturePath = `${pathPrefix}tests/crash.repro.test.ts`;
  const configuredFixture = process.env.REMEDIATOR_FIXTURE_PATH?.trim();
  const fixturePattern = new RegExp(`^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}tests/[A-Za-z0-9._/-]+\\.test\\.ts$`);
  const safeFixturePath = configuredFixture && fixturePattern.test(configuredFixture) ? configuredFixture : fixturePath;
  remediation = {
    repository: process.env.REMEDIATOR_REPOSITORY ?? '',
    setupCommand: process.env.REMEDIATOR_SETUP_COMMAND ?? (standaloneSample ? 'bun install --frozen-lockfile' : 'bun install --frozen-lockfile --filter ./apps/sample'),
    reproduceCommand: `bun test ${safeFixturePath}`,
    testCommand: standaloneSample ? `bun test ${safeFixturePath}` : (process.env.REMEDIATOR_TEST_COMMAND ?? 'bun run --cwd apps/sample test'),
    buildCommand: process.env.REMEDIATOR_BUILD_COMMAND ?? (standaloneSample ? 'bun run build' : 'bun run --cwd apps/sample build'),
    provider: {
      modelName: process.env.REMEDIATOR_MODEL_NAME ?? 'dedicated-remediator',
      modelId: process.env.REMEDIATOR_MODEL_ID!,
      baseUrl: process.env.REMEDIATOR_MODEL_BASE_URL!,
      apiBackend: (process.env.REMEDIATOR_MODEL_API_BACKEND ?? 'chat_completions') as RemediationConfig['provider']['apiBackend'],
      apiKey: process.env.REMEDIATOR_MODEL_API_KEY!,
      githubReadToken: process.env.GITHUB_READ_TOKEN ?? 'github-app',
    },
    reproductionFixture: {
      path: safeFixturePath,
      sourceFile: resolve(packageDirectory, '..', '..', standaloneSample || safeFixturePath.startsWith('src/')
        ? 'packages/remediator/fixtures/task-crash.src.test.ts.txt'
        : 'packages/remediator/fixtures/task-crash.sample.test.ts.txt'),
    },
  };
}
const hub = new ActivityHub({
  saveRun: run => { void Promise.resolve(store.saveAgentRun(run)).catch(() => undefined); },
  saveEvent: (runId, event) => { void Promise.resolve(store.saveAgentEvent(runId, event)).catch(() => undefined); },
});
const installationRepositoryCache = new Map<string, { at: number; names: string[] }>();

async function cachedInstallationRepositories(appId: string, pem: string, installationId: string): Promise<string[]> {
  const key = `${appId}:${installationId}`;
  const cached = installationRepositoryCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.names;
  const names = await listInstallationRepositories(appId, pem, installationId);
  installationRepositoryCache.set(key, { at: Date.now(), names });
  return names;
}

const actions = createControllerActions({ slackWebhookUrl: process.env.SLACK_WEBHOOK_URL, remediation, settings: store }, hub);
const incidentApi = createIncidentApi(store);
const settingsApi = createSettingsApi(store);
const activityApi = createActivityApi({
  hub,
  loadRuns: () => Promise.resolve(store.listAgentRuns()),
  loadRun: id => Promise.resolve(store.getAgentRun(id)).then(run => run && {
    ...run,
    events: run.events.flatMap(event => {
      const phase = event.phase;
      const kind = event.kind;
      if (!['sandbox', 'checkout', 'setup', 'reproduction', 'agent', 'verification', 'patch'].includes(phase)) return [];
      if (!['stage', 'tool', 'message', 'usage', 'status'].includes(kind)) return [];
      return [{ seq: event.seq, at: event.at, phase: phase as 'agent', kind: kind as 'status', message: event.message }];
    }),
  }),
  lookupIncident: id => store.get(id),
  dispatch: (runId, incident, source) => dispatchRun(hub, runId, incident, source, remediation),
  token: process.env.NEXATHON_RUN_TOKEN,
  aiConfigured: Boolean(remediation),
});
const watch = {
  checkedAt: null as string | null,
  outcome: 'starting' as 'starting' | 'healthy' | 'failing' | 'incident' | 'unavailable',
  detail: 'Waiting for the first production check.',
  probePath: monitorConfig?.probePath ?? '/api/tasks',
  rollbackEnabled: Boolean(monitorConfig?.rollbackEnabled),
  intervalMs: monitorConfig?.pollIntervalMs ?? 30_000,
  logsIntervalMs: monitorConfig?.logsIntervalMs ?? 30_000,
  failures: 0,
  probe: null as { checkedAt: string; result: 'pass' | 'fail' | 'unknown'; evidence: string; statusCode?: number } | null,
  logs: [] as RuntimeLog[],
  logsCheckedAt: null as string | null,
  logsError: null as string | null,
  logsSource: null as 'runtime-logs' | 'deployment-events' | null,
  deployment: null as { id: string; url: string; createdAt: string } | null,
};

let vercelDevice: { code: string; expiresAt: number } | undefined;
let monitorWorker: PollingWorker | undefined;
let logsTimer: ReturnType<typeof setInterval> | undefined;
let deploymentWatchTimer: ReturnType<typeof setInterval> | undefined;
let logsPulling = false;
let rateLimitedUntil = 0;

function dashboardOrigin(): string {
  const configured = process.env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5173';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('DASHBOARD_ORIGIN must be an http(s) origin without credentials.');
  }
  return url.origin;
}

const { policy: classificationPolicy, problem: classificationProblem } = policyFromEnvironment();
if (classificationProblem) console.warn(classificationProblem);

const sentry = sentryFromEnvironment();
if (sentry.configured()) console.info('Sentry evidence source is configured (advisory only).');
const sentryEvidence = () => sentry.evidenceLines();
const posthog = posthogFromEnvironment();
if (posthog.configured()) console.info('PostHog evidence source is configured (advisory only).');
const posthogEvidence = () => posthog.evidenceLines();

function providerForService(config: MonitorConfig, service: WatchedService): DeploymentProvider {
  if (config.platform !== 'vercel') return config.provider;
  if (service.vercelProjectId === config.projectId && service.productionHost === (process.env.VERCEL_PRODUCTION_DOMAIN ?? '').toLowerCase()) {
    return config.provider;
  }
  const token = process.env.VERCEL_ACCESS_TOKEN;
  if (!token) return config.provider;
  return new VercelProvider({
    accessToken: token,
    projectId: service.vercelProjectId,
    productionDomain: service.productionHost,
    teamId: service.teamId || process.env.VERCEL_TEAM_ID,
    runtimeLogWindowMs: config.logsIntervalMs + 30_000,
  });
}

async function launchMonitor(config: MonitorConfig): Promise<void> {
  if (monitorWorker) return;
  await store.ready;
  await ensureLegacyWatchedService(store);
  const services = (await store.listWatchedServices()).filter(service => service.enabled);
  const targets: WatchTarget[] = services.length
    ? services.map(service => ({
      projectId: service.vercelProjectId,
      probePath: service.probePath,
      serviceId: service.id,
      repository: service.repository,
      role: service.role,
      provider: providerForService(config, service),
      ...(service.sentryProject ? { sentryProject: service.sentryProject } : {}),
      ...(service.posthogProject ? { posthogProject: service.posthogProject } : {}),
    }))
    : [{ projectId: config.projectId, probePath: config.probePath, provider: config.provider, role: 'app' }];
  watch.probePath = targets[0]?.probePath ?? config.probePath;
  watch.rollbackEnabled = config.rollbackEnabled;
  watch.intervalMs = config.pollIntervalMs;
  monitorWorker = startPollingWorker({
    projectIds: targets.map(target => target.projectId),
    targets,
    allowlistedProjectIds: config.rollbackEnabled ? new Set(targets.map(target => target.projectId)) : new Set(),
    probePath: config.probePath,
    provider: config.provider,
    store,
    actions,
    classificationPolicy,
    sentryEvidence,
    posthogEvidence,
    intervalMs: config.pollIntervalMs,
    deploymentStatusIntervalMs: config.deploymentStatusIntervalMs,
    onResult: (_, result) => {
      watch.checkedAt = new Date().toISOString();
      if (result.probe) {
        watch.probe = {
          checkedAt: watch.checkedAt,
          result: result.probe.result,
          evidence: result.probe.evidence,
          ...(result.probe.statusCode !== undefined ? { statusCode: result.probe.statusCode } : {}),
        };
      }
      if (result.action === 'monitor') {
        watch.failures = result.consecutiveFailures;
        watch.outcome = result.consecutiveFailures > 0 ? 'failing' : 'healthy';
        watch.detail = result.reason;
      } else if (result.action === 'incident') {
        watch.failures = 3;
        watch.outcome = 'incident';
        watch.detail = `${result.incident.status}: ${result.incident.evidence[0] ?? 'Incident recorded.'}`;
      } else {
        watch.failures = 0;
        watch.outcome = 'unavailable';
        watch.detail = result.reason;
        console.error(`Controller monitor unavailable: ${result.reason}`);
      }
      if (result.action === 'incident' && (!result.duplicate || result.updated)) {
        console.info(`Incident ${result.incident.id}: ${result.incident.status}`);
      }
    },
    onError: () => {
      watch.checkedAt = new Date().toISOString();
      watch.outcome = 'unavailable';
      watch.detail = 'The production check failed before a result was recorded.';
      console.error('Controller monitor cycle failed.');
    },
  });
  if (config.provider.listDeploymentsSince && config.provider.getDeploymentEvents) {
    // Scheduled pull method: deployment event logs are immutable, so each
    // deployment is fetched from /v3/deployments/{id}/events at most once
    // (plus once more while it is still building). A window query lists the
    // deployments created since the last cycle, and every request respects
    // Vercel's rate-limit headers by backing off until the window resets.
    const listDeploymentsSince = config.provider.listDeploymentsSince.bind(config.provider);
    const getDeploymentEvents = config.provider.getDeploymentEvents.bind(config.provider);
    const getRateLimit = config.provider.getRateLimit?.bind(config.provider);
    const logCache = new Map<string, RuntimeLog[]>();
    const pulled = new Set<string>();
    const incomplete = new Set<string>();
    let displayedDeploymentId: string | undefined;

    const rateLimited = (): boolean => {
      if (Date.now() < rateLimitedUntil) return true;
      const info = getRateLimit?.();
      if (info?.remaining !== null && info?.remaining !== undefined && info.remaining <= 20) {
        const reset = info.reset ?? Date.now() + 60_000;
        if (reset > Date.now()) {
          rateLimitedUntil = reset;
          console.info(`Vercel rate limit nearly exhausted (${info.remaining} left); log pulls pause until ${new Date(reset).toISOString()}.`);
          return true;
        }
      }
      return false;
    };

    const pullDeployment = async (deployment: { id: string; state?: string }): Promise<void> => {
      if (rateLimited()) return;
      const logs = await getDeploymentEvents(config.projectId, deployment.id);
      logCache.set(deployment.id, logs);
      if (logCache.size > 12) logCache.delete(logCache.keys().next().value!);
      pulled.add(deployment.id);
      // A deployment first seen mid-build has a partial event stream; pull it
      // again on a later cycle once it reports a terminal state.
      if (deployment.state && deployment.state !== 'READY' && deployment.state !== 'ERROR') {
        incomplete.add(deployment.id);
      } else {
        incomplete.delete(deployment.id);
      }
    };

    const bindDisplay = async (deployment: { id: string; immutableUrl: string; createdAt: string }): Promise<void> => {
      watch.deployment = { id: deployment.id, url: deployment.immutableUrl, createdAt: deployment.createdAt };
      watch.logsSource = 'deployment-events';
      displayedDeploymentId = deployment.id;
      watch.logs = logCache.get(deployment.id) ?? watch.logs;
      if (!logCache.has(deployment.id) || incomplete.has(deployment.id)) {
        try {
          await pullDeployment(deployment);
          watch.logs = logCache.get(deployment.id) ?? [];
          watch.logsError = null;
        } catch (error) {
          watch.logsError = error instanceof Error ? error.message : 'Deployment events could not be retrieved.';
        }
      }
      watch.logsCheckedAt = new Date().toISOString();
    };

    const logProvider = new Proxy(config.provider, {
      get(target, property, receiver) {
        if (property === 'getLatestDeploymentStatus') return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const observeRuntime = async (target: WatchTarget, deploymentId: string, logs: RuntimeLog[], fresh: RuntimeLog[]): Promise<void> => {
      const signal = runtimeLogSignal(logs, fresh, deploymentId);
      if (!signal) return;
      const upstream = /upstream dependency/i.test(signal.evidence);
      const result = await checkProject({
        projectId: target.projectId,
        allowlistedProjectIds: config.rollbackEnabled ? new Set([target.projectId]) : new Set(),
        probePath: target.probePath || config.probePath,
        provider: target.provider ?? logProvider,
        ...(target.serviceId ? { serviceId: target.serviceId } : {}),
        ...(target.repository ? { repository: target.repository } : {}),
        ...(target.role ? { serviceRole: target.role } : {}),
        sentryEvidence: () => sentry.evidenceLines(upstream ? undefined : target.sentryProject),
        posthogEvidence: () => posthog.evidenceLines(upstream ? undefined : target.posthogProject),
        store,
        actions,
        classificationPolicy,
        logSignal: signal,
      });
      if (result.action === 'monitor' && result.consecutiveFailures > watch.failures) {
        watch.failures = result.consecutiveFailures;
        watch.outcome = 'failing';
        watch.detail = result.reason;
      } else if (result.action === 'incident' && (!result.duplicate || result.updated)) {
        watch.failures = 3;
        watch.outcome = 'incident';
        watch.detail = `${result.incident.status}: ${result.incident.evidence[0] ?? 'Incident recorded.'}`;
        console.info(`Incident ${result.incident.id}: ${result.incident.status}`);
      }
    };

    const runPullCycle = async (): Promise<void> => {
      if (logsPulling || rateLimited()) return;
      logsPulling = true;
      try {
        const since = Date.now() - 2 * config.logsIntervalMs;
        const deployments: DeploymentSummary[] = await listDeploymentsSince(config.projectId, since);
        for (const deployment of deployments) {
          if (!pulled.has(deployment.id) || incomplete.has(deployment.id)) await pullDeployment(deployment);
        }
        if (config.provider.getRuntimeLogs) {
          for (const target of targets) {
            const provider = target.provider ?? config.provider;
            if (!provider.getRuntimeLogs || !provider.getProductionDeployment) continue;
            try {
              const current = await provider.getProductionDeployment(target.projectId);
              if (!current) continue;
              const logs = await provider.getRuntimeLogs(target.projectId, current.id);
              const fresh = await store.saveRuntimeLogs(target.projectId, current.id, logs);
              if (target.projectId === targets[0]?.projectId) {
                watch.deployment = { id: current.id, url: current.immutableUrl, createdAt: current.createdAt };
                watch.logsSource = 'runtime-logs';
                watch.logs = logs.slice(-200);
              }
              await observeRuntime(target, current.id, logs, fresh);
            } catch (error) {
              if (target.projectId === targets[0]?.projectId) throw error;
              console.error(`Log pull failed for ${target.projectId}.`);
            }
          }
        }
        watch.logsCheckedAt = new Date().toISOString();
        watch.logsError = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The scheduled deployment log pull failed.';
        if (message.includes('HTTP 429')) rateLimitedUntil = Date.now() + 60_000;
        watch.logsCheckedAt = new Date().toISOString();
        watch.logsError = message;
      } finally {
        logsPulling = false;
      }
    };

    void (async () => {
      try {
        const current = await config.provider.getProductionDeployment(config.projectId);
        if (current) await bindDisplay(current);
      } catch { /* the first scheduled cycle retries */ }
    })();
    void runPullCycle();
    logsTimer = setInterval(() => { void runPullCycle(); }, config.logsIntervalMs);
    // The production alias can move at any moment (a new deploy promoted or a
    // rollback). Detect the switch so the panel names the deployment that
    // currently serves production without waiting a full pull cycle.
    deploymentWatchTimer = setInterval(() => {
      if (logsPulling || rateLimited() || displayedDeploymentId === undefined) return;
      void (async () => {
        try {
          const current = await config.provider.getProductionDeployment(config.projectId);
          if (current && current.id !== displayedDeploymentId) await bindDisplay(current);
        } catch { /* the next scheduled cycle retries */ }
      })();
    }, 15_000);
  }
  console.info(`Monitoring enabled for configured ${config.platform} service ${config.projectId}; rollback ${config.rollbackEnabled ? 'enabled' : 'disabled'}.`);
}

async function stopMonitor(): Promise<void> {
  if (logsTimer) clearInterval(logsTimer);
  logsTimer = undefined;
  if (deploymentWatchTimer) clearInterval(deploymentWatchTimer);
  deploymentWatchTimer = undefined;
  await monitorWorker?.stop();
  monitorWorker = undefined;
  await localEngine?.stop();
  localEngine = undefined;
}

// --- Local demo monitor (BE2): watches BE1's TaskFlow services and acts through the broker. ---
let localEngine: LocalEngine | undefined;

function localDemoBaseUrl(): string | undefined {
  const base = process.env.CONTROLLER_DEMO_BASE_URL?.trim().replace(/\/$/, '');
  if (!base) return undefined;
  const url = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CONTROLLER_DEMO_BASE_URL must be a credential-free http(s) origin.');
  }
  if (url.protocol === 'http:' && !local) {
    throw new Error('CONTROLLER_DEMO_BASE_URL must be localhost over http; demo controls stay local-only.');
  }
  return base;
}

function startLocalDemoMonitor(): void {
  if (localEngine) return;
  const base = localDemoBaseUrl();
  if (!base) return;
  localEngine = startLocalEngine({
    demoBaseUrl: base,
    store,
    remediate: incident => actions.remediate ? actions.remediate(incident) : Promise.resolve({ ok: false, message: 'Remediation is not configured.' }),
    pollIntervalMs: Number(process.env.CONTROLLER_DEMO_POLL_INTERVAL_MS ?? 5_000),
    detectionThreshold: Number(process.env.CONTROLLER_DEMO_DETECTION_THRESHOLD ?? 1),
  });
  console.info(`Local demo monitor started against ${base}.`);
}

async function integrationRoutes(request: Request, settingsStore: typeof store): Promise<Response | null> {
  const url = new URL(request.url);
  const dashboard = dashboardOrigin();
  if (url.pathname === '/api/github/webhook' && request.method === 'POST') {
    const body = await request.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    if (!secret) return Response.json({ error: 'GitHub webhook secret is not configured.' }, { status: 503 });
    if (!verifyGithubWebhook(body, request.headers.get('x-hub-signature-256'), secret)) {
      return Response.json({ error: 'GitHub webhook signature did not match.' }, { status: 401 });
    }
    if (request.headers.get('x-github-event') !== 'issue_comment') return new Response(null, { status: 204 });

    const deliveryId = request.headers.get('x-github-delivery') ?? '';
    if (!followupLedger.claim(deliveryId)) {
      auditLog.record({ actor: 'system', action: 'pr.followup', target: deliveryId || 'unknown', outcome: 'denied', detail: 'duplicate delivery ignored' });
      return Response.json({ ok: true, ignored: 'duplicate delivery' }, { status: 202 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return Response.json({ error: 'Invalid webhook payload.' }, { status: 400 }); }
    const outcome = readCommentWebhook(parsed, {
      allowedRepository: process.env.REMEDIATOR_ALLOWED_REPOSITORY || process.env.REMEDIATOR_REPOSITORY || '',
      allowedInstallationId: process.env.GITHUB_INSTALLATION_ID,
      allowedAuthors: (process.env.GITHUB_COMMAND_ALLOWLIST ?? '').split(',').map(item => item.trim()).filter(Boolean),
      mention: process.env.GITHUB_COMMAND_MENTION || '@sentinel',
    });
    if (outcome.kind === 'ignored') {
      auditLog.record({ actor: 'system', action: 'pr.followup', target: deliveryId || 'unknown', outcome: 'denied', detail: outcome.reason });
      return Response.json({ ok: true, ignored: outcome.reason }, { status: 202 });
    }

    const key = `${outcome.event.repository}#${outcome.event.pullRequestNumber}`;
    if (!followupLock.tryAcquire(key)) {
      auditLog.record({ actor: 'system', action: 'pr.followup', target: key, outcome: 'denied', detail: 'a run is already active for this pull request' });
      return Response.json({ ok: false, ignored: 'a run is already active for this pull request' }, { status: 202 });
    }
    const strategy = chooseStrategy({
      sandboxResumeSupported: process.env.E2B_RESUME_SUPPORTED === 'true',
      ...(process.env.E2B_LAST_SANDBOX_ID ? { previousSandboxId: process.env.E2B_LAST_SANDBOX_ID } : {}),
      ...(process.env.E2B_LAST_SANDBOX_EXPIRES ? { previousExpiresAt: process.env.E2B_LAST_SANDBOX_EXPIRES } : {}),
    });
    const followup = buildFollowupContext(outcome.event, outcome.instruction);
    auditLog.record({ actor: 'system', action: 'pr.followup', target: key, outcome: 'allowed', detail: `accepted: ${strategy.strategy} sandbox` });
    // Sandbox execution requires E2B credentials and a configured repository.
    // Without them the comment is accepted and recorded, never silently dropped.
    const executable = Boolean(remediation);
    followupLock.release(key);
    return Response.json({
      ok: true,
      accepted: { repository: followup.repository, pullRequest: followup.pullRequestNumber, strategy: strategy.strategy, reason: strategy.reason },
      executed: executable,
      ...(executable ? {} : { note: 'Remediation is not configured on this controller, so the follow-up was recorded but no sandbox was started.' }),
    }, { status: 202 });
  }
  if (url.pathname === '/api/github/connect' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const target = githubConnectTarget(process.env.GITHUB_APP_SLUG, process.env.GITHUB_APP_ID);
    if ('error' in target) return Response.json({ error: target.error }, { status: 409 });
    return Response.redirect(target.redirect, 302);
  }
  if (url.pathname === '/api/github/repos' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const appId = process.env.GITHUB_APP_ID;
    const pem = process.env.GITHUB_APP_PEM;
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    if (!appId || !pem || !installationId) return Response.json({ error: 'Give the GitHub bot access before choosing a repository.' }, { status: 409 });
    try {
      const repositories = await cachedInstallationRepositories(appId, pem, installationId);
      const query = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
      const matched = query ? repositories.filter(name => name.toLowerCase().includes(query)) : repositories;
      return Response.json(
        { repositories: matched.slice(0, query ? 50 : matched.length), total: repositories.length, matched: matched.length },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch {
      return Response.json({ error: 'The GitHub bot could not list repositories.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/github/callback' && request.method === 'GET') {
    const returnedState = url.searchParams.get('state');
    if (returnedState && !githubStateOk(returnedState)) return Response.json({ error: 'GitHub connect state did not match.' }, { status: 400 });
    const code = url.searchParams.get('code');
    if (!code) return Response.json({ error: 'GitHub did not return an app code.' }, { status: 400 });
    try {
      const saved = await exchangeGithubManifest(code);
      await settingsStore.writeSettings(saved);
      const slug = saved.GITHUB_APP_SLUG;
      return Response.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`, 302);
    } catch {
      return Response.json({ error: 'GitHub app setup did not finish.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/github/installed' && request.method === 'GET') {
    const installationId = url.searchParams.get('installation_id');
    const appId = process.env.GITHUB_APP_ID;
    const pem = process.env.GITHUB_APP_PEM;
    if (!installationId || !/^\d+$/.test(installationId) || !appId || !pem) return Response.json({ error: 'GitHub installation id was missing.' }, { status: 400 });
    if (!await installationExists(appId, pem, installationId)) return Response.json({ error: 'That installation does not belong to the configured GitHub bot.' }, { status: 403 });
    await settingsStore.writeSettings({ GITHUB_INSTALLATION_ID: installationId });
    process.env.GITHUB_INSTALLATION_ID = installationId;
    return Response.redirect(`${dashboard}/?setup=github`, 302);
  }
  if (url.pathname === '/api/vercel/projects' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const token = process.env.VERCEL_ACCESS_TOKEN;
    if (!token) return Response.json({ error: 'Connect Vercel before listing projects.' }, { status: 409 });
    const headers = { Authorization: `Bearer ${token}` };
    try {
      let response = await fetch('https://api.vercel.com/v9/projects', { headers });
      if (!response.ok && process.env.VERCEL_TEAM_ID) {
        response = await fetch(`https://api.vercel.com/v9/projects?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`, { headers });
      }
      if (!response.ok) return Response.json({ error: 'Vercel did not list projects.' }, { status: 502 });
      const body = await response.json() as { projects?: { id?: string; name?: string; accountId?: string; alias?: { domain?: string }[]; targets?: { production?: { alias?: string[] } } }[] };
      const projects = (body.projects ?? []).flatMap(project => {
        if (!project.id || !project.name) return [];
        const domains = [
          ...(project.targets?.production?.alias ?? []),
          ...(project.alias ?? []).flatMap(alias => alias.domain ? [alias.domain] : []),
        ];
        return [{ id: project.id, name: project.name, domains, teamId: project.accountId?.startsWith('team_') ? project.accountId : '' }];
      });
      const selected = matchingVercelProject(projects, process.env.VERCEL_PRODUCTION_DOMAIN ?? '');
      return Response.json({ projects, selected });
    } catch {
      return Response.json({ error: 'Vercel did not list projects.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/vercel/deployments' && request.method === 'GET') {
    const token = process.env.VERCEL_ACCESS_TOKEN;
    const projectId = url.searchParams.get('projectId') || process.env.VERCEL_PROJECT_ID || '';
    if (!token || !projectId) return Response.json({ deployments: [], error: 'Connect Vercel and choose a project first.' }, { status: 400 });
    const api = new URL('https://api.vercel.com/v6/deployments');
    api.searchParams.set('projectId', projectId);
    api.searchParams.set('limit', '15');
    const teamId = process.env.VERCEL_TEAM_ID;
    if (teamId) api.searchParams.set('teamId', teamId);
    const response = await fetch(api, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return Response.json({ deployments: [], error: 'Vercel did not list deployments.' }, { status: 502 });
    const body = await response.json() as { deployments?: { uid?: string; url?: string; state?: string; created?: number; meta?: { githubCommitRef?: string; githubCommitSha?: string } }[] };
    const deployments = (body.deployments ?? []).flatMap(item => item.uid ? [{
      id: item.uid,
      url: item.url ?? '',
      state: item.state ?? 'UNKNOWN',
      createdAt: item.created ? new Date(item.created).toISOString() : '',
      ref: item.meta?.githubCommitRef ?? '',
      sha: item.meta?.githubCommitSha?.slice(0, 7) ?? '',
    }] : []);
    return Response.json({ deployments, selected: process.env.CONTROLLER_WATCH_DEPLOYMENT_ID ?? '' });
  }
  if (url.pathname === '/api/disconnect' && request.method === 'POST') {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: 'Expected JSON.' }, { status: 400 }); }
    const provider = body && typeof body === 'object' && 'provider' in body ? (body as { provider?: unknown }).provider : undefined;
    if (provider !== 'github' && provider !== 'vercel') return Response.json({ error: 'Choose github or vercel to disconnect.' }, { status: 400 });
    const keys = [...disconnectFields[provider]];
    await settingsStore.deleteSettings(keys);
    for (const key of keys) delete process.env[key];
    if (provider === 'vercel') {
      await stopMonitor();
      process.env.CONTROLLER_MONITOR_ENABLED = 'false';
      await settingsStore.writeSettings({ CONTROLLER_MONITOR_ENABLED: 'false' });
    }
    return Response.json({ ok: true, disconnected: provider });
  }
  if (url.pathname === '/api/monitor/start' && request.method === 'POST') {
    if (monitorWorker) return Response.json({ ok: true, already: true });
    await applyStoredSettings(settingsStore);
    if (!process.env.REMEDIATOR_REPOSITORY) return Response.json({ error: 'Choose a repository before starting the monitor.' }, { status: 400 });
    process.env.CONTROLLER_MONITOR_ENABLED = 'true';
    await settingsStore.writeSettings({ CONTROLLER_MONITOR_ENABLED: 'true' });
    try {
      launchMonitor(readMonitorConfig());
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'The monitor did not start.' }, { status: 400 });
    }
    return Response.json({ ok: true, started: true });
  }
  if (url.pathname === '/api/vercel/connect' && request.method === 'POST') {
    try {
      const device = await startVercelDevice();
      vercelDevice = { code: device.deviceCode, expiresAt: device.expiresAt };
      return Response.json({ userCode: device.userCode, verificationUri: device.verificationUri, intervalMs: device.intervalMs });
    } catch {
      return Response.json({ error: 'Vercel sign-in did not start.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/vercel/connect' && request.method === 'GET') {
    if (!vercelDevice || vercelDevice.expiresAt < Date.now()) return Response.json({ error: 'Start Vercel sign-in again.' }, { status: 404 });
    try {
      const result = await pollVercelDevice(vercelDevice.code);
      if (result.pending) return Response.json({ pending: true });
      if (!result.accessToken) return Response.json({ error: 'Vercel sign-in did not finish.' }, { status: 502 });
      await settingsStore.writeSettings({
        VERCEL_ACCESS_TOKEN: result.accessToken,
        ...(result.refreshToken ? { VERCEL_REFRESH_TOKEN: result.refreshToken } : {}),
      });
      process.env.VERCEL_ACCESS_TOKEN = result.accessToken;
      if (result.refreshToken) process.env.VERCEL_REFRESH_TOKEN = result.refreshToken;
      vercelDevice = undefined;
      return Response.json({ ok: true, restartRequired: true });
    } catch {
      return Response.json({ error: 'Vercel sign-in did not finish.' }, { status: 502 });
    }
  }
  return null;
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch: async (request, bunServer) => {
    const url = new URL(request.url);
    // Login attempts are rate limited per client before any credential check.
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const limited = loginLimiter.check(clientKey(request));
      if (!limited.allowed) {
        auditLog.record({ actor: 'anonymous', action: 'auth.login', target: clientKey(request), outcome: 'denied', detail: 'rate limited' });
        return Response.json({ error: 'Too many attempts. Try again shortly.' }, { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } });
      }
    }
    const authResponse = await dashboardAuth.handle(request);
    if (authResponse) return authResponse;
    if (url.pathname.startsWith('/api/') && !dashboardAuth.isPublic(url.pathname)) {
      const role = dashboardAuth.roleOf(request);
      const required = requiredRole(request.method, url.pathname);
      if (!role) return dashboardAuth.unauthorized();
      if (!roleAllows(role, required)) {
        auditLog.record({ actor: role, action: `${request.method} ${url.pathname}`, target: url.pathname, outcome: 'denied', detail: `requires ${required}` });
        return dashboardAuth.forbidden();
      }
      if (required === 'operator' || required === 'admin') {
        const limited = actionLimiter.check(`${role}:${clientKey(request)}`);
        if (!limited.allowed) {
          auditLog.record({ actor: role, action: `${request.method} ${url.pathname}`, target: url.pathname, outcome: 'denied', detail: 'rate limited' });
          return Response.json({ error: 'Too many sensitive operations. Try again shortly.' }, { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } });
        }
        auditLog.record({ actor: role, action: `${request.method} ${url.pathname}`, target: url.pathname, outcome: 'allowed' });
      }
    }
    const connect = await integrationRoutes(request, store);
    if (connect) return connect;
    const settingsResponse = await settingsApi(request);
    if (settingsResponse) return settingsResponse;
    if (url.pathname === '/api/watched-services') {
      if (request.method === 'GET') return Response.json({ services: await store.listWatchedServices() });
      if (request.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^svc-[a-z0-9-]{4,40}$/.test(id)) return Response.json({ error: 'Service id is required.' }, { status: 400 });
        await store.deleteWatchedService(id);
        return Response.json({ ok: true });
      }
      if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: 'Expected JSON.' }, { status: 400 }); }
      const parsed = parseWatchedService(body);
      if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
      await store.saveWatchedService(parsed);
      return Response.json({ ok: true, service: parsed });
    }
    if (url.pathname === '/api/watch') {
      if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
      return Response.json({ ...watch, now: new Date().toISOString() });
    }
    // --- BE2 local demo endpoints ---
    if (url.pathname === '/api/services' && request.method === 'GET') {
      if (!localEngine) return Response.json({ error: 'Local demo monitor is not running. Set CONTROLLER_DEMO_BASE_URL and restart.' }, { status: 409 });
      try {
        return Response.json({ services: await localEngine.adapter.serviceStatuses() });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Service status is unavailable.' }, { status: 502 });
      }
    }
    if (url.pathname === '/api/actions/dry-run' && request.method === 'POST') {
      if (!localEngine) return Response.json({ error: 'Local demo monitor is not running. Set CONTROLLER_DEMO_BASE_URL and restart.' }, { status: 409 });
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: 'Expected JSON.' }, { status: 400 }); }
      const record = body && typeof body === 'object' && 'request' in body ? (body as { request?: unknown }).request : body;
      if (!record || typeof record !== 'object') return Response.json({ error: 'Expected a broker request.' }, { status: 400 });
      const candidate = record as Record<string, unknown>;
      const request_ = {
        kind: String(candidate.kind ?? ''),
        target: String(candidate.target ?? ''),
        ...(candidate.revision !== undefined ? { revision: String(candidate.revision) } : {}),
        ...(candidate.configKey !== undefined ? { configKey: String(candidate.configKey) } : {}),
        ...(candidate.configValue !== undefined ? { configValue: String(candidate.configValue) } : {}),
      } as Parameters<typeof localEngine.broker.dryRun>[0];
      try {
        const decision = await localEngine.broker.dryRun(request_, 'dry-run-probe');
        return Response.json({ decision, proposed: request_ });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Dry run failed.' }, { status: 502 });
      }
    }
    if (url.pathname === '/api/broker/audit' && request.method === 'GET') {
      return Response.json({ audit: localEngine ? localEngine.broker.auditTrail() : [] });
    }
    if (url.pathname === '/api/evidence/sentry' && request.method === 'GET') {
      const evidence = await sentry.recentIssues();
      return Response.json({ configured: evidence.configured, ok: evidence.ok, detail: evidence.detail, issues: evidence.issues });
    }
    if (url.pathname === '/api/evidence/posthog' && request.method === 'GET') {
      const evidence = await posthog.recentIssues();
      return Response.json({ configured: evidence.configured, ok: evidence.ok, detail: evidence.detail, issues: evidence.issues });
    }
    if (url.pathname === '/api/audit' && request.method === 'GET') {
      return Response.json({ entries: auditLog.list(200), roles: dashboardAuth.configuredRoles() });
    }
    return (await activityApi(request, bunServer)) ?? incidentApi(request);
  },
});
console.log(`Incident API listening on http://${server.hostname}:${server.port}`);
if (!process.env.NEXATHON_RUN_TOKEN) {
  console.info('Agent runs are read-only: set NEXATHON_RUN_TOKEN to allow the local CLI to start one.');
}

if (monitorConfig) launchMonitor(monitorConfig);
startLocalDemoMonitor();

void (async () => {
  if (!actions.remediate) return;
  const open = await store.list(100);
  for (const incident of open) {
    if (incident.status !== 'needs_human') continue;
    if (incident.events.some(item => item.type === 'remediation_started' || item.type === 'draft_pr')) continue;
    incident.events.push({
      at: new Date().toISOString(),
      type: 'remediation_retry',
      message: 'This incident was waiting for a person. Starting a sandbox fix and pull request anyway.',
    });
    await finishRemediation(incident, { store, actions } as unknown as Parameters<typeof finishRemediation>[1]);
  }
})();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopMonitor();
  server.stop();
  await store.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(); });
}
