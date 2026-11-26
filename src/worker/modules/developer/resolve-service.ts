import type { Resolved } from '../../../shared/contracts/workbench-read.ts';
import { type WbTool, wbPath } from '../../../shared/workbench.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { contextOrg } from '../workbench/context.ts';
import {
  attemptInOrg,
  captureInOrg,
  endpointInOrg,
  eventInOrg,
  keyInOrg,
  liveInOrg,
  operationInOrg,
  passInOrg,
  requestByRequestId,
  templateInOrg,
} from './repo-resolve.ts';

/** `portal`: the older kinds open in the developer site, as `/developer/resolve` always did. */
export type ResolveStyle = 'portal' | 'workbench';

/** A sandbox owner has no admin pages, so objects open in the portal: the console, or the log filtered to the object's path. */
const logsFor = (path: string) => `/developers/logs#path=${encodeURIComponent(path)}`;

/**
 * What a pasted id names inside the caller's Test context: a request first (its row in the log), then the sandbox
 * and the objects of the org. The organization is the caller's, never the id's, so an id from anywhere else is
 * simply not found. An id that exists only in Live answers `live`, which opens in admin and never in the Workbench.
 */
export async function resolveId(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  rawId: string,
  options: { orgId?: string | undefined; style?: ResolveStyle } = {},
): Promise<Resolved> {
  const orgId = await contextOrg(ctx, auth, options.orgId);
  const portal = (options.style ?? 'workbench') === 'portal';
  const tool = (name: WbTool, hash?: string, query?: Record<string, string>) =>
    wbPath(orgId, name, { ...(query && { query }), ...(hash !== undefined && { hash }) });
  const db = ctx.env.DB;
  const id = rawId.toLowerCase();

  const request = await requestByRequestId(db, orgId, id, ctx.clock.now());
  if (request)
    return {
      kind: 'request',
      id: request.request_id,
      href: portal
        ? `/developers/logs#${encodeURIComponent(request.request_id)}`
        : tool('logs', request.request_id),
      label: `${request.method} ${request.path.replace(/^\/api\/v1/, '')}, ${request.status}`,
    };
  if (id === orgId.toLowerCase())
    return {
      kind: portal ? 'org' : 'sandbox',
      id: orgId,
      href: portal ? '/developers/console' : tool('home'),
      label: 'Your sandbox',
    };
  const pass = await passInOrg(db, orgId, id);
  if (pass)
    return {
      kind: 'pass',
      id: pass.id,
      href: portal ? logsFor(`/passes/${pass.id}`) : tool('passes', pass.id),
      label: pass.serial,
    };
  const template = await templateInOrg(db, orgId, id);
  if (template)
    return {
      kind: 'template',
      id: template.id,
      href: portal
        ? logsFor(`/templates/${template.id}`)
        : `${wbPath(orgId, 'design')}/${encodeURIComponent(template.id)}`,
      label: template.name,
    };
  const key = await keyInOrg(db, orgId, id);
  if (key) return { kind: 'key', id: key.id, href: tool('keys', key.id), label: key.name };
  const event = await eventInOrg(db, orgId, id);
  if (event)
    return {
      kind: 'event',
      id: event.event_id,
      href: tool('events', event.event_id),
      label: event.type,
    };
  const endpoint = await endpointInOrg(db, orgId, id);
  if (endpoint)
    return {
      kind: 'endpoint',
      id: endpoint.id,
      href: tool('events', endpoint.id, { tab: 'endpoints' }),
      label: endpoint.target === 'capture' ? 'Capture endpoint' : 'Endpoint',
    };
  const capture = await captureInOrg(db, orgId, id);
  if (capture)
    return {
      kind: 'capture',
      id: capture.id,
      href: tool('events', capture.event_id, { capture: capture.id }),
      label: `Capture of ${capture.event_type}`,
    };
  const attempt = await attemptInOrg(db, orgId, id);
  if (attempt)
    return {
      kind: 'delivery',
      id: attempt.id,
      href: tool('events', attempt.event_id ?? attempt.endpoint_id, {
        endpoint: attempt.endpoint_id,
      }),
      label: `Delivery attempt ${attempt.attempt}`,
    };
  const operation = await operationInOrg(db, orgId, id);
  if (operation)
    return {
      kind: 'operation',
      id: operation.id,
      href: tool('activity', operation.id),
      label: operation.kind,
    };
  const live = await liveInOrg(db, orgId, id);
  if (live)
    return {
      kind: 'live',
      id,
      href:
        live.what === 'pass' || live.what === 'event'
          ? `/admin/o/${orgId}/passes/${live.pass_id}`
          : `/admin/o/${orgId}/${live.what === 'key' ? 'api-keys' : 'connections'}`,
      label: `Live ${live.what}`,
    };
  throw new NotFoundError('Nothing with this id in your Test data.', 'RESOLVE_NOT_FOUND');
}
