import type { DemoServiceId, HealthState, ServiceStatus } from '@nexathon/contracts';

/**
 * Adapter for the local TaskFlow demo environment. All operations hit the
 * narrowly scoped fault/reset API the demo environment exposes on the compose
 * network — never the Docker socket or arbitrary host commands. Endpoints are
 * configurable so tests can point at a stub server.
 */

export interface LocalAdapterOptions {
  demoBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DemoFaultState {
  activeFault?: 'bad_deployment' | 'bad_config' | 'dependency_down' | 'resource_exhaustion' | 'ambiguous';
  faultInjectedAt?: string;
  knownGoodRevision?: string;
  knownGoodConfig?: Record<string, string>;
}

export interface JourneyResult {
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
}

const defaultTimeoutMs = 5_000;

export class LocalDemoAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LocalAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const token = process.env.DEMO_CONTROL_TOKEN?.trim();
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(new URL(path, this.options.demoBaseUrl).toString(), {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Demo API ${path} returned HTTP ${response.status}.`);
    return response.json() as Promise<T>;
  }

  async serviceStatuses(): Promise<ServiceStatus[]> {
    const statuses = await this.call<{ services: ServiceStatus[] }>('/api/demo/services');
    return statuses.services;
  }

  async faultState(): Promise<DemoFaultState> {
    return this.call<DemoFaultState>('/api/demo/state');
  }

  /** The end-to-end user journey: real TaskFlow operation through the task API and dependency. */
  async runJourney(): Promise<JourneyResult> {
    try {
      const result = await this.call<{ ok: boolean; detail: string }>('/api/demo/journey');
      return { result: result.ok ? 'pass' : 'fail', detail: result.detail };
    } catch (error) {
      return { result: 'unknown', detail: `Journey request failed: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }

  async restoreRevision(revision: string): Promise<void> {
    await this.call('/api/demo/actions/restore-revision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) });
  }

  async restoreConfig(key: string, value: string): Promise<void> {
    await this.call('/api/demo/actions/restore-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  }

  async restartService(serviceId: string): Promise<void> {
    await this.call('/api/demo/actions/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: serviceId }) });
  }
}

export function healthFromStatus(status: ServiceStatus | undefined): HealthState {
  return status?.health ?? 'unknown';
}

export function serviceName(serviceId: string): string {
  const names: Record<DemoServiceId, string> = { frontend: 'TaskFlow frontend', 'task-api': 'Task API', dependency: 'Dependency service' };
  return names[serviceId as DemoServiceId] ?? serviceId;
}
