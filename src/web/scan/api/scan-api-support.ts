import type { z } from 'zod';
import type { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';

export { problemOf } from './problem.ts';

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
/** `problems` asks for the refusals and holds of the last 15 minutes instead of the newest scans. */
export type Call = { signal?: AbortSignal; problems?: boolean };

export const activityPath = (call?: Call): string =>
  call?.problems ? '/activity?problems=1' : '/activity';

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

export const rosterQuery = (cursor: string | undefined, since: number | undefined): string => {
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  if (since !== undefined) q.set('since', String(since));
  return q.size > 0 ? `?${q}` : '';
};

/** The device's one request function: the credential, the retries and the typed answer. */
export type ScanRequest = <S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  schema: S | null,
  body?: unknown,
  call?: Call,
) => Promise<z.infer<S>>;
