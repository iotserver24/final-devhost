/**
 * Declarative multi-target configuration.
 *
 * Each target is independent: its own provider, routes, thresholds and rollback
 * policy. A target that is misconfigured or unreachable is reported as a
 * problem and skipped; it never stops monitoring of the other targets.
 */

export type TargetKind = 'http' | 'vm';

export interface VmTargetSettings {
  /** Base URL of the restricted VM agent. Fixed operations only, never a shell. */
  agentUrl: string;
  /** Application name the agent will act on; must be on the agent allowlist. */
  application: string;
  /** Health path used for verification after a rollback. */
  healthPath: string;
  /** Require TLS verification. Set false only for a documented local tunnel. */
  verifyTls?: boolean;
}

export interface TargetDefinition {
  id: string;
  name: string;
  kind: TargetKind;
  environment?: string;
  /** Name of the provider adapter used for `http` targets. */
  provider?: 'vercel' | 'railway' | 'render' | 'coolify';
  /** Public base URL used for probes. */
  url?: string;
  probePath?: string;
  criticalRoutes?: string[];
  /** Consecutive failures before an incident. */
  failureThreshold?: number;
  rollback?: {
    enabled: boolean;
    /** Maximum automatic rollback attempts per deployment. */
    maxAttempts: number;
  };
  /** Notification target label; delivery configuration stays in the controller env. */
  notify?: string;
  vm?: VmTargetSettings;
}

export interface TargetsConfig {
  targets: TargetDefinition[];
  problems: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_TARGETS = 25;

function isLocal(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

function safeUrl(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    problems.push(`${label}: a URL is required`);
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      problems.push(`${label}: URL must not embed credentials`);
      return undefined;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      problems.push(`${label}: URL must use http or https`);
      return undefined;
    }
    if (url.protocol === 'http:' && !isLocal(url.hostname)) {
      problems.push(`${label}: plain HTTP is only allowed for localhost targets`);
      return undefined;
    }
    return value.replace(/\/$/, '');
  } catch {
    problems.push(`${label}: URL is not valid`);
    return undefined;
  }
}

function safePath(value: unknown, label: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\/(?!\/)[A-Za-z0-9/_.-]*$/.test(value) || value.includes('..')) {
    problems.push(`${label}: path must be an absolute route without traversal`);
    return undefined;
  }
  return value;
}

/**
 * Parse and validate a target list. Invalid entries are dropped with a problem
 * message so one bad target cannot take down the others.
 */
export function parseTargets(input: unknown): TargetsConfig {
  const problems: string[] = [];
  if (!Array.isArray(input)) return { targets: [], problems: ['Target configuration must be an array'] };
  if (input.length > MAX_TARGETS) problems.push(`Only the first ${MAX_TARGETS} targets are used`);

  const targets: TargetDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.slice(0, MAX_TARGETS).entries()) {
    const label = `target[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label}: must be an object`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!ID_PATTERN.test(id)) {
      problems.push(`${label}: id must match ${ID_PATTERN}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${label}: duplicate id "${id}"`);
      continue;
    }
    const kind: TargetKind = item.kind === 'vm' ? 'vm' : item.kind === 'http' || item.kind === undefined ? 'http' : (problems.push(`${label}: unsupported kind`), 'http');
    if (item.kind !== undefined && item.kind !== 'http' && item.kind !== 'vm') continue;

    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : id;
    const target: TargetDefinition = { id, name, kind };

    if (typeof item.environment === 'string' && item.environment.trim()) target.environment = item.environment.trim().slice(0, 40);

    if (kind === 'vm') {
      const vm = item.vm && typeof item.vm === 'object' ? item.vm as Record<string, unknown> : null;
      if (!vm) {
        problems.push(`${label}: vm targets require a vm block`);
        continue;
      }
      const agentUrl = safeUrl(vm.agentUrl, `${label}.vm.agentUrl`, problems);
      const application = typeof vm.application === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(vm.application)
        ? vm.application
        : (problems.push(`${label}.vm.application: a safe application name is required`), undefined);
      const healthPath = safePath(vm.healthPath ?? '/health', `${label}.vm.healthPath`, problems) ?? '/health';
      if (!agentUrl || !application) continue;
      target.vm = { agentUrl, application, healthPath, ...(vm.verifyTls === false ? { verifyTls: false } : {}) };
      target.url = agentUrl;
    } else {
      const url = safeUrl(item.url, `${label}.url`, problems);
      if (!url) continue;
      target.url = url;
      target.provider = ['vercel', 'railway', 'render', 'coolify'].includes(String(item.provider))
        ? item.provider as TargetDefinition['provider']
        : undefined;
      const probePath = safePath(item.probePath ?? '/api/tasks', `${label}.probePath`, problems);
      target.probePath = probePath ?? '/api/tasks';
      if (Array.isArray(item.criticalRoutes)) {
        target.criticalRoutes = item.criticalRoutes
          .filter((route): route is string => typeof route === 'string' && route.startsWith('/'));
      }
    }

    if (typeof item.failureThreshold === 'number' && Number.isInteger(item.failureThreshold) && item.failureThreshold >= 1 && item.failureThreshold <= 100) {
      target.failureThreshold = item.failureThreshold;
    }
    const rollback = item.rollback && typeof item.rollback === 'object' ? item.rollback as Record<string, unknown> : undefined;
    target.rollback = {
      enabled: rollback?.enabled === true,
      maxAttempts: typeof rollback?.maxAttempts === 'number' && Number.isInteger(rollback.maxAttempts) && rollback.maxAttempts >= 0 && rollback.maxAttempts <= 5
        ? rollback.maxAttempts
        : 1,
    };
    if (typeof item.notify === 'string' && item.notify.trim()) target.notify = item.notify.trim().slice(0, 80);

    seen.add(id);
    targets.push(target);
  }

  return { targets, problems };
}

/** Read targets from CONTROLLER_TARGETS (JSON array), falling back to single-target env. */
export function targetsFromEnvironment(env: Record<string, string | undefined> = process.env): TargetsConfig {
  const raw = env.CONTROLLER_TARGETS?.trim();
  if (raw) {
    try {
      return parseTargets(JSON.parse(raw));
    } catch {
      return { targets: [], problems: ['CONTROLLER_TARGETS is not valid JSON'] };
    }
  }
  // Backward compatibility: derive one target from the existing single-target env.
  const domain = env.VERCEL_PRODUCTION_DOMAIN?.trim();
  if (!domain) return { targets: [], problems: [] };
  const parsed = parseTargets([{
    id: 'primary',
    name: 'Primary target',
    kind: 'http',
    provider: 'vercel',
    url: `https://${domain.replace(/^https?:\/\//, '')}`,
    probePath: env.CONTROLLER_PROBE_PATH ?? '/api/tasks',
    ...(env.CONTROLLER_CRITICAL_ROUTES ? { criticalRoutes: env.CONTROLLER_CRITICAL_ROUTES.split(',').map(item => item.trim()).filter(Boolean) } : {}),
  }]);
  return parsed;
}