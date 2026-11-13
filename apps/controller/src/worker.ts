import type { MonitorOptions, MonitorResult } from './monitor';
import { checkProject } from './monitor';

export interface WatchTarget {
  projectId: string;
  probePath?: string;
  serviceId?: string;
  repository?: string;
  role?: 'app' | 'dependency';
  provider?: MonitorOptions['provider'];
  sentryProject?: string;
  posthogProject?: string;
}

export interface PollingWorkerOptions extends Omit<MonitorOptions, 'projectId'> {
  projectIds: string[];
  /** Per-service probe path and provider. Falls back to the shared options when omitted. */
  targets?: WatchTarget[];
  intervalMs?: number;
  deploymentStatusIntervalMs?: number;
  startImmediately?: boolean;
  onResult?: (projectId: string, result: MonitorResult) => void | Promise<void>;
  onError?: (projectId: string) => void | Promise<void>;
}

export interface PollingWorker {
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

export function startPollingWorker(options: PollingWorkerOptions): PollingWorker {
  const targets: WatchTarget[] = options.targets?.length
    ? options.targets.filter(target => target.projectId.trim())
    : [...new Set(options.projectIds.map(id => id.trim()).filter(Boolean))].map(projectId => ({ projectId }));
  if (targets.length === 0) throw new Error('At least one monitored Vercel project ID is required.');

  const intervalMs = Math.max(1_000, Math.min(Math.trunc(options.intervalMs ?? 30_000), 300_000));
  const deploymentStatusIntervalMs = Math.max(1_000, Math.min(Math.trunc(options.deploymentStatusIntervalMs ?? 60_000), 600_000));
  const lastDeploymentStatusAt = new Map<string, number>();
  const groups = new Map<string, WatchTarget[]>();
  for (const target of targets) groups.set(target.projectId, [...(groups.get(target.projectId) ?? []), target]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const active = new Map<string, Promise<void>>();
  let stopped = false;

  const runGroup = (projectId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const running = active.get(projectId);
    if (running) return running;
    const cycle = (async () => {
      for (const target of groups.get(projectId) ?? []) {
        if (stopped) break;
        let result: MonitorResult;
        try {
          const now = Date.now();
          const statusDue = !lastDeploymentStatusAt.has(projectId)
            || now - lastDeploymentStatusAt.get(projectId)! >= deploymentStatusIntervalMs;
          if (statusDue) lastDeploymentStatusAt.set(projectId, now);
          const selectedProvider = target.provider ?? options.provider;
          const provider = statusDue || !selectedProvider.getLatestDeploymentStatus
            ? selectedProvider
            : new Proxy(selectedProvider, {
              get(instance, property, receiver) {
                if (property === 'getLatestDeploymentStatus') return undefined;
                const value = Reflect.get(instance, property, receiver);
                return typeof value === 'function' ? value.bind(instance) : value;
              },
            });
          result = await checkProject({
            ...options, provider, projectId, probePath: target.probePath || options.probePath,
            ...(target.serviceId ? { serviceId: target.serviceId } : {}),
            ...(target.repository ? { repository: target.repository } : {}),
            ...(target.role ? { serviceRole: target.role } : {}),
            ...(target.sentryProject ? { sentryProject: target.sentryProject } : {}),
            ...(target.posthogProject ? { posthogProject: target.posthogProject } : {}),
          });
        } catch {
          try { await options.onError?.(projectId); } catch { /* keep polling */ }
          continue;
        }
        try { await options.onResult?.(projectId, result); } catch {
          try { await options.onError?.(projectId); } catch { /* keep polling */ }
        }
      }
    })().finally(() => {
      active.delete(projectId);
      if (!stopped) timers.set(projectId, setTimeout(() => { timers.delete(projectId); void runGroup(projectId); }, intervalMs));
    });
    active.set(projectId, cycle);
    return cycle;
  };

  const worker: PollingWorker = {
    pollNow: async () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all([...groups.keys()].map(runGroup));
    },
    stop: async () => {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all([...active.values()]);
    },
  };

  if (options.startImmediately !== false) {
    for (const projectId of groups.keys()) void runGroup(projectId);
  }
  return worker;
}
