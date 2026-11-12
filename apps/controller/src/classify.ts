/**
 * Configurable HTTP error classification.
 *
 * A probe result is not "pass/fail". The same status code means different
 * things depending on the route, the repetition, and the baseline. This module
 * is pure so the policy is testable and the monitor stays unchanged for
 * providers that cannot report a status code.
 */

export type ErrorClass =
  /** Request succeeded; nothing to do. */
  | 'healthy'
  /** Expected or ignorable (for example a normal 404). Sample it, do not page. */
  | 'ignored'
  /** Worth investigating; not sufficient for an automated action. */
  | 'warning'
  /** Actionable incident; may proceed to guarded remediation. */
  | 'incident'
  /** Insufficient or conflicting evidence; escalate to a human. */
  | 'unknown';

export interface ClassificationPolicyConfig {
  /** Statuses that are informational by default. */
  ignoredStatuses: number[];
  /** Statuses that warrant investigation when they repeat. */
  warningStatuses: number[];
  /** Statuses that indicate a service failure. */
  incidentStatuses: number[];
  /** Routes expected to always exist; a 404 here is a real problem. */
  criticalRoutes: string[];
  /** Consecutive observations of the same non-2xx status needed to escalate. */
  repeatThreshold: number;
  /** A 404 count at or above this multiple of the baseline is a spike. */
  notFoundSpikeMultiplier: number;
  /** Minimum baseline used for the spike ratio so tiny numbers do not misfire. */
  notFoundSpikeFloor: number;
}

export const defaultPolicy: ClassificationPolicyConfig = {
  ignoredStatuses: [404],
  warningStatuses: [400, 401, 403, 405, 408, 409, 410, 422, 429],
  incidentStatuses: [500, 501, 502, 503, 504, 507, 508],
  criticalRoutes: ['/api/health'],
  repeatThreshold: 3,
  notFoundSpikeMultiplier: 5,
  notFoundSpikeFloor: 10,
};

export interface ProbeObservation {
  /** Route or route template that was probed. */
  route: string;
  /** HTTP status; absent when the request failed before a response. */
  statusCode?: number;
  /** Consecutive occurrences of this status on this route. */
  occurrences?: number;
  /** Recent 404 count for this route, when the monitor has a baseline. */
  notFoundCount?: number;
  /** Baseline 404 rate for this route over a comparable window. */
  baselineNotFound?: number;
  /** Explicitly marked critical by target configuration. */
  critical?: boolean;
}

export interface Classification {
  classification: ErrorClass;
  statusCode?: number;
  route: string;
  reason: string;
}

function isCritical(observation: ProbeObservation, policy: ClassificationPolicyConfig): boolean {
  if (observation.critical) return true;
  return policy.criticalRoutes.some(route => route === observation.route);
}

export function classifyProbe(
  observation: ProbeObservation,
  policy: ClassificationPolicyConfig = defaultPolicy,
): Classification {
  const { route, statusCode } = observation;
  const occurrences = Math.max(0, observation.occurrences ?? 1);

  if (statusCode === undefined) {
    return { classification: 'unknown', route, reason: 'No HTTP response was received; the endpoint may be unreachable.' };
  }
  if (statusCode >= 200 && statusCode < 400) {
    return { classification: 'healthy', statusCode, route, reason: `HTTP ${statusCode} is a success response.` };
  }

  // 404 is the interesting case. Normal missing pages are noise; a missing
  // critical route or a spike in 404s is a real signal.
  if (statusCode === 404) {
    if (isCritical(observation, policy)) {
      return { classification: 'incident', statusCode, route, reason: `HTTP 404 on critical route ${route}; the route is expected to exist.` };
    }
    const baseline = observation.baselineNotFound;
    const count = observation.notFoundCount;
    if (baseline !== undefined && count !== undefined) {
      const floor = Math.max(baseline, policy.notFoundSpikeFloor);
      if (count >= floor * policy.notFoundSpikeMultiplier) {
        return { classification: 'incident', statusCode, route, reason: `HTTP 404 volume on ${route} is ${count}, at least ${policy.notFoundSpikeMultiplier}x the baseline of ${baseline}.` };
      }
    }
    return { classification: 'ignored', statusCode, route, reason: `HTTP 404 on ${route} is treated as a normal missing page.` };
  }

  // Authentication / authorization problems on a critical route usually mean a
  // configuration or credential fault, which is actionable once repeated.
  if (statusCode === 401 || statusCode === 403) {
    if (isCritical(observation, policy) && occurrences >= policy.repeatThreshold) {
      return { classification: 'incident', statusCode, route, reason: `Repeated HTTP ${statusCode} on critical route ${route}; likely an authentication or configuration fault.` };
    }
    return { classification: 'warning', statusCode, route, reason: `HTTP ${statusCode} on ${route}; a single client or auth rejection is not an incident.` };
  }

  // Timeouts and rate limits are transient by nature. They escalate only when
  // they repeat on a critical route.
  if (statusCode === 408 || statusCode === 429) {
    if (isCritical(observation, policy) && occurrences >= policy.repeatThreshold) {
      return { classification: 'incident', statusCode, route, reason: `Repeated HTTP ${statusCode} on critical route ${route}; the service is not serving requests.` };
    }
    return { classification: 'warning', statusCode, route, reason: `HTTP ${statusCode} on ${route} is transient; watching before acting.` };
  }

  // Server errors. A single 5xx is not enough to act on a production service.
  if (statusCode >= 500) {
    const known = policy.incidentStatuses.includes(statusCode);
    if (occurrences >= policy.repeatThreshold) {
      return {
        classification: 'incident',
        statusCode,
        route,
        reason: `HTTP ${statusCode} repeated ${occurrences} times on ${route}${known ? '' : ' (unlisted status, treated as a server error)'}.`,
      };
    }
    return { classification: 'warning', statusCode, route, reason: `A single HTTP ${statusCode} on ${route} is not enough evidence for an automated action.` };
  }

  // Remaining 4xx: informational unless they repeat.
  if (statusCode >= 400) {
    const listed = policy.warningStatuses.includes(statusCode) || policy.ignoredStatuses.includes(statusCode);
    if (occurrences >= policy.repeatThreshold) {
      return { classification: 'warning', statusCode, route, reason: `HTTP ${statusCode} repeated ${occurrences} times on ${route}; investigate if unexpected.` };
    }
    return {
      classification: 'ignored',
      statusCode,
      route,
      reason: `HTTP ${statusCode} on ${route} is treated as a client mistake${listed ? '' : ' (unlisted status)'}.`,
    };
  }

  return { classification: 'unknown', statusCode, route, reason: `HTTP ${statusCode} on ${route} does not match any configured rule.` };
}

/** True when the classification permits an automated remediation attempt. */
export function mayActOn(classification: ErrorClass): boolean {
  return classification === 'incident';
}

/** True when the classification should be recorded but must not page anyone. */
export function isNoise(classification: ErrorClass): boolean {
  return classification === 'healthy' || classification === 'ignored';
}

/**
 * Read a policy from the environment. Malformed values fall back to the
 * default rather than throwing, because a bad status list must not stop
 * monitoring; the parse failure is reported through `problem`.
 */
export function policyFromEnvironment(env: Record<string, string | undefined> = process.env): {
  policy: ClassificationPolicyConfig;
  problem?: string;
} {
  const statuses = (value: string | undefined): number[] | undefined => {
    if (!value?.trim()) return undefined;
    const parsed = value.split(',').map(item => Number(item.trim()));
    if (parsed.some(item => !Number.isInteger(item) || item < 100 || item > 599)) return undefined;
    return parsed;
  };
  const integer = (value: string | undefined, min: number, max: number): number | undefined => {
    if (!value?.trim()) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
  };

  const ignored = statuses(env.CONTROLLER_IGNORED_STATUSES);
  const warning = statuses(env.CONTROLLER_WARNING_STATUSES);
  const incident = statuses(env.CONTROLLER_INCIDENT_STATUSES);
  const critical = env.CONTROLLER_CRITICAL_ROUTES?.split(',').map(item => item.trim()).filter(item => item.startsWith('/'));
  const repeats = integer(env.CONTROLLER_REPEAT_THRESHOLD, 1, 100);
  const spike = integer(env.CONTROLLER_404_SPIKE_MULTIPLIER, 2, 1000);

  const problems: string[] = [];
  if (env.CONTROLLER_IGNORED_STATUSES?.trim() && !ignored) problems.push('CONTROLLER_IGNORED_STATUSES');
  if (env.CONTROLLER_WARNING_STATUSES?.trim() && !warning) problems.push('CONTROLLER_WARNING_STATUSES');
  if (env.CONTROLLER_INCIDENT_STATUSES?.trim() && !incident) problems.push('CONTROLLER_INCIDENT_STATUSES');
  if (env.CONTROLLER_REPEAT_THRESHOLD?.trim() && !repeats) problems.push('CONTROLLER_REPEAT_THRESHOLD');

  return {
    policy: {
      ...defaultPolicy,
      ...(ignored ? { ignoredStatuses: ignored } : {}),
      ...(warning ? { warningStatuses: warning } : {}),
      ...(incident ? { incidentStatuses: incident } : {}),
      ...(critical?.length ? { criticalRoutes: critical } : {}),
      ...(repeats ? { repeatThreshold: repeats } : {}),
      ...(spike ? { notFoundSpikeMultiplier: spike } : {}),
    },
    ...(problems.length ? { problem: `Ignored malformed policy values: ${problems.join(', ')}` } : {}),
  };
}