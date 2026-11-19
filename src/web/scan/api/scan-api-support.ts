import type { z } from 'zod';
import type { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';

export interface Problem {
  code: string;
  title?: string;
  detail?: string;
  requestId?: string;
  fields?: Record<string, string>;
}

/** Reads a problem+json body leniently: a proxy or an older server may leave fields out. */
export function problemOf(data: unknown): Problem | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.code !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const fields: Record<string, string> = {};
  if (Array.isArray(o.issues))
    for (const issue of o.issues as unknown[]) {
      const i = issue as { path?: unknown; message?: unknown } | null;
      if (typeof i?.path === 'string' && typeof i.message === 'string') fields[i.path] = i.message;
    }
  return {
    code: o.code,
    title: str(o.title),
    detail: str(o.detail),
    requestId: str(o.requestId),
    fields,
  };
}

export interface ScanApiDeps {
  fetch?: typeof fetch;
  /** The scan session's CSRF secret, read per write. Undefined for a bearer or before the session. */
  csrf: () => string | undefined;
  scope?: () => AdminScope | undefined;
  /** Waits before the one retry of a 409. */
  sleep?: (ms: number) => Promise<void>;
  /** Refetches the scan session and its configuration (a 409 `SCAN_CONFIG_CHANGED` or `SCAN_STAFF_CHANGED`). */
  refreshConfig?: () => Promise<void>;
}

export type AdminScope = z.infer<typeof ScanAdminScopeSchema>;
export type Call = { signal?: AbortSignal };

export function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** An admin names the org (and event, templates) on a GET as a query. */
export function scopeQuery(scope: AdminScope | undefined): string {
  if (!scope) return '';
  const q = new URLSearchParams({ orgId: scope.orgId });
  if (scope.eventId) q.set('eventId', scope.eventId);
  if (scope.setupId) q.set('setupId', scope.setupId);
  if (scope.templateIds?.length) q.set('templateIds', scope.templateIds.join(','));
  q.set('timeZone', scope.timeZone);
  return `?${q.toString()}`;
}
