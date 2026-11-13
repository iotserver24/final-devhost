/**
 * Authorization, rate limiting, and audit for dashboard operations.
 *
 * Authentication answers "who is this"; this module answers "may they do it".
 * Roles are intentionally coarse: viewer reads, operator acts, admin configures.
 */

export type DashboardRole = 'viewer' | 'operator' | 'admin';

export const roleRank: Record<DashboardRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function isRole(value: unknown): value is DashboardRole {
  return value === 'viewer' || value === 'operator' || value === 'admin';
}

/** Lowest role permitted for a method/path pair. Undefined means public/unknown. */
export function requiredRole(method: string, pathname: string): DashboardRole | undefined {
  const upper = method.toUpperCase();

  // Configuration and credentials: administrators only.
  if (pathname === '/api/settings' && upper !== 'GET') return 'admin';
  if (pathname === '/api/disconnect') return 'admin';
  if (pathname.startsWith('/api/github/connect')) return 'admin';
  if (pathname.startsWith('/api/vercel/connect')) return 'admin';

  // Reading configuration exposes integration names but never secrets; admins.
  if (pathname === '/api/settings' && upper === 'GET') return 'admin';

  // Actions and monitoring control: operators.
  if (pathname.startsWith('/api/actions/')) return 'operator';
  if (pathname.startsWith('/api/monitor/')) return 'operator';
  if (pathname === '/api/internal/agent-runs') return 'operator';

  // Everything else readable is available to viewers.
  if (upper === 'GET' || upper === 'HEAD') return 'viewer';
  return 'operator';
}

export function roleAllows(role: DashboardRole | undefined, required: DashboardRole | undefined): boolean {
  if (!required) return true;
  if (!role) return false;
  return roleRank[role] >= roleRank[required];
}

/** Fixed-window rate limiter with bounded memory. */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the call is allowed; also reports how long to wait. */
  check(key: string): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [existingKey, existing] of this.buckets) {
          if (existing.resetAt <= now) this.buckets.delete(existingKey);
        }
        if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0, remaining: this.limit - 1 };
    }
    if (bucket.count >= this.limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now, remaining: 0 };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0, remaining: this.limit - bucket.count };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}

export interface AuditEntry {
  at: string;
  actor: DashboardRole | 'anonymous' | 'system';
  action: string;
  target: string;
  outcome: 'allowed' | 'denied' | 'failed';
  detail?: string;
}

/** In-memory, bounded audit trail for sensitive operations. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly capacity = 500, private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<AuditEntry, 'at'>): AuditEntry {
    const complete: AuditEntry = { at: this.now().toISOString(), ...entry };
    this.entries.push(complete);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return complete;
  }

  list(limit = 100): AuditEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.capacity)));
  }
}