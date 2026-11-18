import type { Context } from 'hono';
import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanAdminScopeSchema } from '../../../shared/contracts/scan.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError, ValidationError, zodIssues } from '../../platform/errors.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { countOrgTemplates, readValidEventScope, type ScanEventRow } from './repo-scope.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The `scope` a request carries: the JSON body's, or `?orgId&eventId&templateIds&timeZone` on a GET. */
export async function rawScopeOf(c: Context<AppBindings>): Promise<unknown> {
  if (SAFE.has(c.req.method)) {
    const q = c.req.query();
    if (q.orgId === undefined && q.eventId === undefined && q.templateIds === undefined)
      return undefined;
    return {
      orgId: q.orgId,
      eventId: q.eventId,
      templateIds: q.templateIds ? q.templateIds.split(',').filter(Boolean) : undefined,
      timeZone: q.timeZone,
      setupId: q.setupId,
    };
  }
  if (!c.req.header('content-type')?.includes('json')) return undefined;
  const text = await c.req.text();
  if (text === '') return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError('The request body is not valid JSON.', [], 'SCAN_BODY_INVALID');
  }
  return body && typeof body === 'object' && 'scope' in body
    ? (body as { scope: unknown }).scope
    : undefined;
}

export interface ResolvedScope {
  orgId: string;
  event: ScanEventRow | null;
  templateIds: string[];
  timeZone: string;
}

/**
 * Validates an admin's scope. Unknown or foreign ids, invalid events, and templates without an
 * approved release in the request's mode all answer 404 with the body of any unknown id.
 */
export async function resolveAdminScope(
  c: Context<AppBindings>,
  raw: unknown,
  mode: Mode,
): Promise<ResolvedScope & { eventTemplateIds: string[] }> {
  const parsed = ScanAdminScopeSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(
      'Choose an organization to scan for.',
      zodIssues(parsed.error),
      'SCAN_SCOPE_REQUIRED',
    );
  const scope: z.infer<typeof ScanAdminScopeSchema> = parsed.data;
  const db = c.env.DB;
  if (!(await orgIsReadable(db, scope.orgId))) throw new NotFoundError();
  const eventScope = scope.eventId
    ? await readValidEventScope(db, scope.orgId, mode, scope.eventId)
    : null;
  if (scope.eventId && !eventScope) throw new NotFoundError();
  const event = eventScope?.event ?? null;
  const templateIds = [...new Set(scope.templateIds ?? [])];
  if (
    templateIds.length > 0 &&
    (await countOrgTemplates(db, scope.orgId, mode, templateIds)) !== templateIds.length
  )
    throw new NotFoundError();
  return {
    orgId: scope.orgId,
    event,
    eventTemplateIds: eventScope?.templateIds ?? [],
    templateIds,
    timeZone: event?.timeZone ?? scope.timeZone,
  };
}
