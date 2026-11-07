/**
 * The device API client (SA 5.1). Typed calls for every route under `/api/v1/scan`.
 *
 * It does not use the shared `api` client: a paired scanner sends no mode header (its mode is bound
 * on the server), the CSRF secret comes from the scan session and is kept in memory only, and a
 * 429 must surface its `Retry-After`.
 */
import type { z } from 'zod';
import {
  type ScanActRequestSchema,
  type ScanAdminScopeSchema,
  ScanCountsSchema,
  ScanOutcomeSchema,
  type ScanResolveRequestSchema,
  type ScanUndoRequestSchema,
} from '../../../shared/contracts/scan.ts';
import {
  type ScanBatchRequestSchema,
  ScanBatchResultSchema,
  type ScanLookupRequestSchema,
  ScanLookupResultSchema,
  ScanPairPreviewSchema,
  ScanRecentSchema,
  ScanRosterSchema,
  ScanSessionSchema,
  type ScanStaffSignInSchema,
  ScanSummarySchema,
} from '../../../shared/contracts/scan-session.ts';
import {
  type ScanDeviceCapabilities,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { modeHeaders } from '../../lib/mode.ts';
import { ScanApiError } from './errors.ts';

export { ScanApiError } from './errors.ts';

const BASE = '/api/v1/scan';

interface Problem {
  code: string;
  title?: string;
  detail?: string;
  requestId?: string;
}

/** Reads a problem+json body leniently: a proxy or an older server may leave fields out. */
function problemOf(data: unknown): Problem | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.code !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { code: o.code, title: str(o.title), detail: str(o.detail), requestId: str(o.requestId) };
}

export interface ScanApiDeps {
  fetch?: typeof fetch;
  /** The scan session's CSRF secret, read per write. Undefined for a bearer or before the session. */
  csrf: () => string | undefined;
  scope?: () => AdminScope | undefined;
  /** Waits before the one retry of a 409. */
  sleep?: (ms: number) => Promise<void>;
}

type AdminScope = z.infer<typeof ScanAdminScopeSchema>;
type Call = { signal?: AbortSignal };

function retryAfterMs(res: Response): number | undefined {
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

export function createScanApi(deps: ScanApiDeps) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function once(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    call: Call,
  ): Promise<{ res: Response; data: unknown }> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(deps.scope?.() ? modeHeaders() : {}),
      ...(deps.scope?.()?.setupId ? { 'x-passbook-scan-admin': '1' } : {}),
    };
    if (method !== 'GET') {
      const token = deps.csrf();
      if (token) headers['x-csrf-token'] = token;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: call.signal,
      });
    } catch (cause) {
      if (call.signal?.aborted) throw cause;
      throw new ScanApiError({ status: 0, code: 'network', detail: 'No connection.' });
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined; // a proxy's HTML page: the status alone decides
    }
    return { res, data };
  }

  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: S | null,
    body?: unknown,
    call: Call = {},
  ): Promise<z.infer<S>> {
    const scope = deps.scope?.();
    if (scope && body && typeof body === 'object' && !path.startsWith('/pair'))
      body = { ...body, scope };
    if (scope && method === 'GET' && !path.includes('orgId='))
      path += `${path.includes('?') ? '&' : '?'}${scopeQuery(scope).slice(1)}`;
    let attempt = await once(method, path, body, call);
    // A scan still being applied by another request: wait as told, once, with the same key.
    if (attempt.res.status === 409) {
      const code = problemOf(attempt.data)?.code;
      if (code === 'SCAN_IN_PROGRESS' || code === 'PASS_CONFLICT') {
        await sleep(retryAfterMs(attempt.res) ?? 1000);
        attempt = await once(method, path, body, call);
      }
    }
    const { res, data } = attempt;
    if (!res.ok) {
      const problem = problemOf(data);
      const wait = retryAfterMs(res);
      if (problem)
        throw new ScanApiError(
          {
            status: res.status,
            code: problem.code,
            ...(problem.title ? { title: problem.title } : {}),
            ...(problem.detail ? { detail: problem.detail } : {}),
            ...(problem.requestId ? { requestId: problem.requestId } : {}),
          },
          wait,
        );
      throw new ScanApiError(
        { status: res.status, code: res.status >= 500 ? 'server_error' : 'request_failed' },
        wait,
      );
    }
    if (schema === null) return undefined as z.infer<S>;
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ScanApiError({
        status: 502,
        code: 'invalid_response',
        detail: `Unexpected response from ${path.split('?')[0]}.`,
      });
    return parsed.data;
  }

  return {
    activity: (call?: Call) => request('GET', '/activity', SessionActivitySchema, undefined, call),
    reportDevice: (capabilities: ScanDeviceCapabilities, call?: Call) =>
      request('POST', '/device', ScanWorkspaceSchema.nullable(), { capabilities }, call),
    pairPreview: (code: string) =>
      request('POST', '/pair/preview', ScanPairPreviewSchema, { code }),
    pair: (code: string) => request('POST', '/pair', ScanSessionSchema, { code }),
    session: (scope?: AdminScope, call?: Call) =>
      request('GET', `/session${scopeQuery(scope)}`, ScanSessionSchema, undefined, call),
    resolve: (body: z.infer<typeof ScanResolveRequestSchema>, call?: Call) =>
      request('POST', '/resolve', ScanOutcomeSchema, body, call),
    act: (body: z.infer<typeof ScanActRequestSchema>, call?: Call) =>
      request('POST', '/actions', ScanOutcomeSchema, body, call),
    undo: (scanId: string, body: z.infer<typeof ScanUndoRequestSchema>, call?: Call) =>
      request('POST', `/scans/${encodeURIComponent(scanId)}/undo`, ScanOutcomeSchema, body, call),
    recent: (scope?: AdminScope, call?: Call) =>
      request(
        'GET',
        `/scans${scopeQuery(scope) || '?'}${scope ? '&' : ''}limit=20`,
        ScanRecentSchema,
        undefined,
        call,
      ),
    lookup: (body: z.infer<typeof ScanLookupRequestSchema>, call?: Call) =>
      request('POST', '/lookup', ScanLookupResultSchema, body, call),
    stats: (o: { signal?: AbortSignal; dayStart?: number } = {}) =>
      request(
        'GET',
        `/stats${o.dayStart !== undefined ? `?dayStart=${o.dayStart}` : ''}`,
        ScanCountsSchema,
        undefined,
        o.signal ? { signal: o.signal } : {},
      ),
    summary: (since: number, call?: Call) =>
      request('GET', `/summary?since=${since}`, ScanSummarySchema, undefined, call),
    signOut: () => request('POST', '/unpair', null),
    staffSignIn: (body: z.infer<typeof ScanStaffSignInSchema>) =>
      request('POST', '/staff', ScanSessionSchema, body),
    staffSignOut: () => request('DELETE', '/staff', ScanSessionSchema),
    roster: (cursor?: string, call?: Call) =>
      request(
        'GET',
        `/roster${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        ScanRosterSchema,
        undefined,
        call,
      ),
    batch: (body: z.infer<typeof ScanBatchRequestSchema>, call?: Call) =>
      request('POST', '/batch', ScanBatchResultSchema, body, call),
  };
}

export type ScanApi = ReturnType<typeof createScanApi>;
