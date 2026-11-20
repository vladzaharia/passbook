import { routePath } from 'hono/route';
import { z } from 'zod';
import {
  ScanActRequestSchema,
  ScanCountsSchema,
  type ScanInput,
  ScanOutcomeSchema,
  ScanResolveRequestSchema,
  ScanUndoRequestSchema,
} from '../../../shared/contracts/scan.ts';
import {
  ScanLookupRequestSchema,
  ScanLookupResultSchema,
  ScanRecentSchema,
  ScanSessionSchema,
  ScanSummarySchema,
  ScanSummaryScopeSchema,
} from '../../../shared/contracts/scan-session.ts';
import {
  ReportScanDeviceSchema,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { notifyHostOfArrival } from '../visitors/arrival.ts';
import { registerScanVisitorRoutes } from '../visitors/routes-scan.ts';
import { deepFreeze } from './freeze.ts';
import { actGroup, undoGroup, withBundle } from './group.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { recentFor, summaryFor } from './history.ts';
import { publishScan } from './live.ts';
import { lookup } from './lookup.ts';
import { withParentHint } from './occupancy/parent-hint.ts';
import { touchOnlineAt } from './repo-roster.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { actTag, resolveTag } from './resolve-tag.ts';
import { registerScanAssetRoute } from './routes-assets.ts';
import { registerScanBrandingRoute } from './routes-branding.ts';
import { registerScanEnrollmentRoutes } from './routes-enrollment.ts';
import { tillKeyAccess } from './routes-key-access.ts';
import { registerScanOccupancyRoutes } from './routes-occupancy.ts';
import { registerScanOfflineRoutes } from './routes-offline.ts';
import { limitScanBodies, registerScanPhotoRoute } from './routes-photo.ts';
import { registerScanRoleRoutes } from './routes-role.ts';
import { registerScanSessionHoursRoutes } from './routes-session-hours.ts';
import { registerScanStaffRoutes } from './routes-staff-session.ts';
import { registerScanTagRoutes } from './routes-tags.ts';
import { capturingContext } from './scan-capture.ts';
import { reportScanDevice } from './scanning-workspace.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { buildSession } from './session.ts';
import { sessionActivityFor } from './session-activity.ts';
import { statsFor } from './stats.ts';

/** Device API: /api/v1/scan. */

/** A tag read is never a presented credential: customer screens skip it and hub rows carry no tag. */
const liveMethod = (input: ScanInput) => ('tag' in input ? 'manual' : input.method);

export const scanRoutes = createRouter({ bodyLimit: false });
limitScanBodies(scanRoutes);

// Admin scope rides the query on a GET (`?orgId&eventId&templateIds&timeZone`); the guard reads it.
const DayStart = z.object({ dayStart: z.coerce.number().int().nonnegative().optional() });

const readActor = requireScanActor({ capability: 'scanning:read' });
const operateActor = requireScanActor({ capability: 'passes:operate' });
const manageActor = requireScanActor({ capability: 'scanning:manage' });
const readSessionActor = requireScanActor({
  capability: 'scanning:read',
  staffOptional: true,
  screens: true,
});
const manageSessionActor = requireScanActor({
  capability: 'scanning:manage',
  staffOptional: true,
  screens: true,
});

scanRoutes.use('/session', (c, next) =>
  (c.req.method === 'GET' ? readSessionActor : manageSessionActor)(c, next),
);
scanRoutes.use('/branding/logo', readSessionActor);
scanRoutes.use(
  '/device',
  requireScanActor({ capability: 'scanning:manage', staffOptional: true, screens: true }),
);
scanRoutes.use('/role', manageSessionActor);
scanRoutes.use('/session/open-now', operateActor);
scanRoutes.use(
  '/staff',
  requireScanActor({ capability: 'scanning:manage', staffOptional: true, screenActions: true }),
);
scanRoutes.use('/actions', (c, next) =>
  (c.req.method === 'POST' ? operateActor : manageActor)(c, next),
);
// A Desk-actions monitor opens the photos Who's in lists.
const photoActor = requireScanActor({ capability: 'scanning:read', screenActions: true });
for (const path of ['/summary', '/stats', '/activity'])
  scanRoutes.use(path, (c, next) => (c.req.method === 'GET' ? readActor : manageActor)(c, next));
scanRoutes.use('/passes/*', (c, next) =>
  (c.req.method === 'GET'
    ? photoActor
    : c.req.method === 'POST' && c.req.path.endsWith('/photo')
      ? operateActor
      : manageActor)(c, next),
);
for (const path of ['/resolve', '/lookup'])
  scanRoutes.use(path, (c, next) => (c.req.method === 'POST' ? readActor : manageActor)(c, next));
// Hono's /scans/* also matches /scans itself, so choose exactly one guard here.
scanRoutes.use('/scans/*', (c, next) => {
  const suffix = c.req.path.slice(routePath(c).length - 2);
  if (c.req.method === 'GET' && suffix === '') return readActor(c, next);
  if (c.req.method === 'POST' && /^\/[^/]+\/undo$/.test(suffix)) return operateActor(c, next);
  return manageActor(c, next);
});
scanRoutes.use('*', tillKeyAccess);
scanRoutes.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
});

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/session',
    summary: 'Scanner session',
    query: DayStart.extend({ pending: z.coerce.number().int().nonnegative().optional() }),
    response: ScanSessionSchema,
  },
  async (c) => {
    const { dayStart, pending } = c.req.valid('query');
    const actor = scanActorOf(c);
    const ctx = serviceContext(c);
    // Online with nothing waiting to sync: no queued read may be dated before now (batch.ts).
    if (pending === 0 && actor.principal === 'scanner' && actor.scanner)
      await touchOnlineAt(ctx.env.DB, actor.scanner.id, actor.orgId, ctx.clock.now());
    const session = await buildSession(ctx, actor, dayStart);
    const auth = c.var.auth;
    if (auth?.kind === 'session' || (auth?.kind === 'scanner' && auth.transport === 'cookie'))
      session.csrfToken = auth.csrfSecret;
    return c.json(session);
  },
);

registerScanStaffRoutes(scanRoutes);
registerScanOccupancyRoutes(scanRoutes);
registerScanVisitorRoutes(scanRoutes);
registerScanRoleRoutes(scanRoutes);
registerScanTagRoutes(scanRoutes);
registerScanSessionHoursRoutes(scanRoutes);
registerScanEnrollmentRoutes(scanRoutes);
registerScanOfflineRoutes(scanRoutes);
registerScanBrandingRoute(scanRoutes);
registerScanPhotoRoute(scanRoutes);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/activity',
    summary: 'Recent activity on this scanning session',
    response: SessionActivitySchema,
  },
  async (c) => {
    return c.json(await sessionActivityFor(serviceContext(c), scanActorOf(c)));
  },
);

register(
  scanRoutes,
  'scan',
  {
    method: 'post',
    path: '/device',
    summary: 'Report screen and input capabilities',
    body: ReportScanDeviceSchema,
    response: ScanWorkspaceSchema.nullable(),
  },
  async (c) =>
    c.json(
      await reportScanDevice(serviceContext(c), scanActorOf(c), c.req.valid('json').capabilities),
    ),
);

register(
  scanRoutes,
  'scan',
  {
    method: 'post',
    path: '/resolve',
    summary: 'Read a code',
    body: ScanResolveRequestSchema,
    response: ScanOutcomeSchema,
  },
  async (c) => {
    const ctx = capturingContext(serviceContext(c)),
      actor = cloneObservedScanActor(scanActorOf(c)),
      req = c.req.valid('json');
    const input = req.input;
    const evaluation =
      'tag' in input
        ? await resolveTag(ctx, actor, { ...req, input })
        : await resolveOutcome(ctx, actor, { ...req, input });
    const { evaluatedSnapshot, credentialContext } = evaluation;
    const outcome = evaluation.outcome;
    publishScan(
      ctx,
      actor,
      outcome,
      evaluatedSnapshot,
      credentialContext,
      liveMethod(input),
      false,
      'code' in input,
    );
    return c.json('tag' in input ? outcome : await withBundle(ctx, actor, evaluation));
  },
);

register(
  scanRoutes,
  'scan',
  {
    method: 'post',
    path: '/actions',
    summary: 'Scan and act',
    body: ScanActRequestSchema,
    response: ScanOutcomeSchema,
  },
  async (c) => {
    // The request and the actor are frozen once, here: nothing below changes either.
    const ctx = capturingContext(serviceContext(c)),
      actor = deepFreeze(cloneObservedScanActor(scanActorOf(c))),
      req = deepFreeze(c.req.valid('json'));
    const input = req.input;
    const evaluation =
      'tag' in input
        ? await actTag(ctx, actor, { ...req, input })
        : await actGroup(ctx, actor, { ...req, input });
    const { outcome, evaluatedSnapshot, credentialContext } = evaluation;
    if (!outcome.replay)
      publishScan(
        ctx,
        actor,
        outcome,
        evaluatedSnapshot,
        credentialContext,
        liveMethod(input),
        false,
        'code' in input,
      );
    notifyHostOfArrival(ctx, actor, outcome);
    return c.json(await withParentHint(ctx.env.DB, actor.orgId, outcome));
  },
);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/scans',
    summary: "This scanner's latest scans",
    query: z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) }),
    response: ScanRecentSchema,
  },
  async (c) =>
    c.json(await recentFor(serviceContext(c), scanActorOf(c), c.req.valid('query').limit)),
);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/summary',
    summary: "This scanner's tally",
    query: z.object({
      since: z.coerce.number().int().nonnegative().optional(),
      scope: ScanSummaryScopeSchema.default('device'),
    }),
    response: ScanSummarySchema,
  },
  async (c) => {
    const { since, scope } = c.req.valid('query');
    return c.json(await summaryFor(serviceContext(c), scanActorOf(c), since, scope));
  },
);

register(
  scanRoutes,
  'scan',
  { method: 'get', path: '/stats', summary: 'Counts', query: DayStart, response: ScanCountsSchema },
  async (c) =>
    c.json(await statsFor(serviceContext(c), scanActorOf(c), c.req.valid('query').dayStart)),
);

registerScanAssetRoute(scanRoutes);

register(
  scanRoutes,
  'scan',
  {
    method: 'post',
    path: '/lookup',
    summary: 'Find a pass',
    body: ScanLookupRequestSchema,
    response: ScanLookupResultSchema,
  },
  async (c) => c.json(await lookup(serviceContext(c), scanActorOf(c), c.req.valid('json').q)),
);
register(
  scanRoutes,
  'scan',
  {
    method: 'post',
    path: '/scans/{scanId}/undo',
    summary: 'Undo a check-in',
    params: z.object({ scanId: z.string().min(1).max(64) }),
    body: ScanUndoRequestSchema,
    response: ScanOutcomeSchema,
  },
  async (c) => {
    const ctx = capturingContext(serviceContext(c)),
      actor = deepFreeze(cloneObservedScanActor(scanActorOf(c)));
    const { outcome, evaluatedSnapshot, credentialContext } = await undoGroup(
      ctx,
      actor,
      c.req.valid('param').scanId,
      c.req.valid('json'),
    );
    if (!outcome.replay)
      publishScan(ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'manual', true);
    return c.json(outcome);
  },
);
