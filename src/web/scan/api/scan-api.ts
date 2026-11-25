/**
 * The device API client (SA 5.1). Typed calls for every route under `/api/v1/scan`.
 *
 * It does not use the shared `api` client: a paired scanner sends no mode header (bound on the server),
 * its CSRF secret stays in memory, and a 429 must surface `Retry-After`.
 */
import type { z } from 'zod';
import {
  type SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { MemberPhotoSchema } from '../../../shared/contracts/check-in.ts';
import {
  ScanTagEnrollmentDoneSchema,
  ScanTagEnrollmentPendingSchema,
} from '../../../shared/contracts/nfc-tag-enrollments.ts';
import {
  ScanTagBindResultSchema,
  ScanTagInspectResponseSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import {
  type ScanActRequestSchema,
  ScanCountsSchema,
  ScanOutcomeSchema,
  type ScanResolveRequestSchema,
  type ScanUndoRequestSchema,
} from '../../../shared/contracts/scan.ts';
import type {
  ScanOverrideNoteSchema,
  ScanOverrideRequestSchema,
} from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanRoleChange } from '../../../shared/contracts/scan-role.ts';
import {
  RollCallCurrentSchema,
  type RollCallMarksRequestSchema,
  RollCallMarksResponseSchema,
  RollCallSchema,
} from '../../../shared/contracts/scan-roll-call.ts';
import {
  type ScanBatchRequestSchema,
  ScanBatchResultSchema,
  type ScanLookupRequestSchema,
  ScanLookupResultSchema,
  ScanPairPreviewSchema,
  ScanRecentSchema,
  ScanRosterSchema,
  ScanSessionSchema,
  ScanStaffSearchSchema,
  type ScanStaffSignInSchema,
  ScanSummarySchema,
} from '../../../shared/contracts/scan-session.ts';
import { SessionDevicesSchema } from '../../../shared/contracts/scanning-session-devices.ts';
import {
  type ScanDeviceCapabilities,
  ScanSessionOpenedSchema,
  type ScanSessionOpenNowSchema,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { VisitorListSchema } from '../../../shared/contracts/visitors.ts';
import { modeHeaders } from '../../lib/mode.ts';
import type { BindBody, TagRead } from '../assign/types.ts';
import {
  InsideListSchema,
  type InsideQuery,
  type MarkOutRequest,
  MarkOutResultSchema,
} from '../inside/inside-types.ts';
import { canReload, ScanApiError } from './errors.ts';
import { personCalls } from './scan-api-person.ts';
import {
  type AdminScope,
  activityPath,
  type Call,
  problemOf,
  retryAfterMs,
  rosterQuery,
  type ScanApiDeps,
  scopeQuery,
} from './scan-api-support.ts';

export { ScanApiError } from './errors.ts';
export type { ScanApiDeps } from './scan-api-support.ts';

const BASE = '/api/v1/scan';

export function createScanApi(deps: ScanApiDeps) {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function once(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  /** The original error is what the person must see; a failed cleanup is retried by the next session read. */
  async function dropStaffSignIn(): Promise<void> {
    try {
      await once('DELETE', '/staff', undefined, {});
      await deps.refreshConfig?.();
    } catch {
      // Nothing to add: the staff-changed error is thrown to the caller either way.
    }
  }

  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S | null,
    body?: unknown,
    call: Call = {},
  ): Promise<z.infer<S>> {
    const scope = deps.scope?.();
    // A bind body's own `scope` is the tag's, not the admin's.
    if (
      scope &&
      body &&
      typeof body === 'object' &&
      !path.startsWith('/pair') &&
      !path.startsWith('/tags')
    )
      body = { ...body, scope };
    if (scope && method === 'GET' && !path.includes('orgId='))
      path += `${path.includes('?') ? '&' : '?'}${scopeQuery(scope).slice(1)}`;
    let attempt = await once(method, path, body, call);
    if (attempt.res.status === 409) {
      const code = problemOf(attempt.data)?.code;
      // A scan still being applied by another request: wait as told, once, with the same key.
      if (code === 'SCAN_IN_PROGRESS' || code === 'PASS_CONFLICT') {
        await sleep(retryAfterMs(attempt.res) ?? 1000);
        attempt = await once(method, path, body, call);
      }
      // The door's configuration moved under this request: reload it and send the same key once more.
      // Never an unpair: only a 401 means the credential is gone.
      else if (code === 'SCAN_CONFIG_CHANGED' && canReload(deps, path, call)) {
        await deps.refreshConfig?.();
        attempt = await once(method, path, body, call);
      }
      // The signed-in staff member changed (role, PIN or access): drop the sign-in so the PIN prompt shows.
      else if (code === 'SCAN_STAFF_CHANGED') await dropStaffSignIn();
      // The hours closed the session under this request: reload it, so the Closed screen shows.
      else if (code === 'SCANNING_SESSION_CLOSED') void deps.refreshConfig?.();
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
            ...(problem.fields ? { fields: problem.fields } : {}),
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
    activity: (call?: Call) =>
      request('GET', activityPath(call), SessionActivitySchema, undefined, call),
    devices: (call?: Call) => request('GET', '/devices', SessionDevicesSchema, undefined, call),
    reportDevice: (capabilities: ScanDeviceCapabilities, call?: Call) =>
      request('POST', '/device', ScanWorkspaceSchema.nullable(), { capabilities }, call),
    pairPreview: (code: string) =>
      request('POST', '/pair/preview', ScanPairPreviewSchema, { code }),
    pair: (code: string) => request('POST', '/pair', ScanSessionSchema, { code }),
    /** `pending`: reads queued on the device; 0 tells the server this contact is a clean one. */
    session: (scope?: AdminScope, call?: Call, pending?: number) =>
      request(
        'GET',
        `/session${scopeQuery(scope)}${pending === undefined ? '' : `${scope ? '&' : '?'}pending=${pending}`}`,
        ScanSessionSchema,
        undefined,
        call,
      ),
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
    summary: (since: number, call?: Call, scope: 'device' | 'session' = 'device') =>
      request('GET', `/summary?since=${since}&scope=${scope}`, ScanSummarySchema, undefined, call),
    signOut: () => request('POST', '/unpair', null),
    staffSignIn: (body: z.infer<typeof ScanStaffSignInSchema>) =>
      request('POST', '/staff', ScanSessionSchema, body),
    staffSignOut: () => request('DELETE', '/staff', ScanSessionSchema),
    setRole: (body: ScanRoleChange) => request('POST', '/role', ScanSessionSchema, body),
    staffSearch: (q: string, call?: Call) =>
      request('GET', `/staff?q=${encodeURIComponent(q)}`, ScanStaffSearchSchema, undefined, call),
    roster: (cursor?: string, since?: number, call?: Call) =>
      request('GET', `/roster${rosterQuery(cursor, since)}`, ScanRosterSchema, undefined, call),
    batch: (body: z.infer<typeof ScanBatchRequestSchema>, call?: Call) =>
      request('POST', '/batch', ScanBatchResultSchema, body, call),
    inside: (query: InsideQuery, call?: Call) => {
      const entries = Object.entries(query).filter(([, v]) => v !== undefined);
      const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
      return request('GET', `/live/inside${qs && `?${qs}`}`, InsideListSchema, undefined, call);
    },
    tagInspect: (body: { tag: TagRead }, call?: Call) =>
      request('POST', '/tags/inspect', ScanTagInspectResponseSchema, body, call),
    tagBind: (body: BindBody, call?: Call) =>
      request('POST', '/tags/bind', ScanTagBindResultSchema, body, call),
    tagUndo: (bindingId: string, call?: Call) =>
      request('POST', `/tags/bindings/${encodeURIComponent(bindingId)}/undo`, null, {}, call),
    tagPending: (call?: Call) =>
      request('GET', '/tag-enrollments/pending', ScanTagEnrollmentPendingSchema, undefined, call),
    tagComplete: (id: string, body: { tag: TagRead }, call?: Call) =>
      request(
        'POST',
        `/tag-enrollments/${encodeURIComponent(id)}/complete`,
        ScanTagEnrollmentDoneSchema,
        body,
        call,
      ),
    tagDecline: (id: string, call?: Call) =>
      request('POST', `/tag-enrollments/${encodeURIComponent(id)}/decline`, null, {}, call),
    openNow: (body: z.infer<typeof ScanSessionOpenNowSchema>, call?: Call) =>
      request('POST', '/session/open-now', ScanSessionOpenedSchema, body, call),
    override: (body: z.infer<typeof ScanOverrideRequestSchema>, call?: Call) =>
      request('POST', '/overrides', ScanOutcomeSchema, body, call),
    overrideNote: (id: string, note: z.infer<typeof ScanOverrideNoteSchema>) =>
      request('POST', `/overrides/${encodeURIComponent(id)}/note`, null, { note }),
    rollCall: (call?: Call) => request('GET', '/roll-call', RollCallCurrentSchema, undefined, call),
    startRollCall: (call?: Call) => request('POST', '/roll-call', RollCallSchema, {}, call),
    rollCallMarks: (id: string, body: z.infer<typeof RollCallMarksRequestSchema>, call?: Call) =>
      request(
        'POST',
        `/roll-call/${encodeURIComponent(id)}/marks`,
        RollCallMarksResponseSchema,
        body,
        call,
      ),
    endRollCall: (id: string, call?: Call) =>
      request('POST', `/roll-call/${encodeURIComponent(id)}/end`, RollCallSchema, {}, call),
    markOut: (body: MarkOutRequest, call?: Call) =>
      request('POST', '/mark-out', MarkOutResultSchema, body, call),
    addPhoto: (passId: string, png: string, call?: Call) =>
      request(
        'POST',
        `/passes/${encodeURIComponent(passId)}/photo`,
        MemberPhotoSchema,
        { png, includeInPass: false },
        call,
      ),
    ...personCalls(request),
    visitors: (day: { start: number; end: number }, call?: Call) =>
      request(
        'GET',
        `/visitors?dayStart=${day.start}&dayEnd=${day.end}`,
        VisitorListSchema,
        undefined,
        call,
      ),
    signOutPerson: (body: z.infer<typeof SignOutRequestSchema>, call?: Call) =>
      request('POST', '/sign-out', SignOutResultSchema, body, call),
  };
}

export type ScanApi = ReturnType<typeof createScanApi>;
