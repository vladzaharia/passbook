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
import { SessionDevicesSchema } from '../../../shared/contracts/scanning-session-devices.ts';
import {
  ReportScanDeviceSchema,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deepFreeze } from './freeze.ts';
import { actGroup, undoGroup, withBundle } from './group.ts';
import { scanActorOf } from './guard.ts';
import { recentFor, summaryFor } from './history.ts';
import { liveReadyId, publishScan } from './live.ts';
import { lookup } from './lookup.ts';
import { withParentHint } from './occupancy/parent-hint.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { actTag, resolveTag } from './resolve-tag.ts';
import { registerScanAssetRoute } from './routes-assets.ts';
import { registerScanBrandingRoute } from './routes-branding.ts';
import { registerScanDraftRoutes } from './routes-draft.ts';
import { registerScanEnrollmentRoutes } from './routes-enrollment.ts';
import { mountScanGuards } from './routes-guards.ts';
import { registerScanHistoryRoutes } from './routes-history.ts';
import { registerScanOccupancyRoutes } from './routes-occupancy.ts';
import { registerScanOfflineRoutes } from './routes-offline.ts';
import { limitScanBodies, registerScanPhotoRoute } from './routes-photo.ts';
import { registerScanRoleRoutes } from './routes-role.ts';
import { registerScanSessionHoursRoutes } from './routes-session-hours.ts';
import { registerScanSignOutRoute } from './routes-sign-out.ts';
import { registerScanStaffRoutes } from './routes-staff-session.ts';
import { registerScanTagRoutes } from './routes-tags.ts';
import { capturingContext } from './scan-capture.ts';
import { reportScanDevice } from './scanning-workspace.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { buildSession } from './session.ts';
import { sessionActivityFor } from './session-activity.ts';
import { sessionDevicesFor } from './session-devices.ts';
import { statsFor } from './stats.ts';

/** Device API: /api/v1/scan. */

/** A tag read is never a presented credential: customer screens skip it and hub rows carry no tag. */
const liveMethod = (input: ScanInput) => ('tag' in input ? 'manual' : input.method);

export const scanRoutes = createRouter({ bodyLimit: false });
limitScanBodies(scanRoutes);

// Admin scope rides the query on a GET (`?orgId&eventId&templateIds&timeZone`); the guard reads it.
const DayStart = z.object({ dayStart: z.coerce.number().int().nonnegative().optional() });

mountScanGuards(scanRoutes);
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
    const { dayStart } = c.req.valid('query');
    const actor = scanActorOf(c);
    const ctx = serviceContext(c);
    const session = await buildSession(ctx, actor, dayStart);
    const auth = c.var.auth;
    if (auth?.kind === 'session' || (auth?.kind === 'scanner' && auth.transport === 'cookie'))
      session.csrfToken = auth.csrfSecret;
    return c.json(session);
  },
);

registerScanStaffRoutes(scanRoutes);
registerScanOccupancyRoutes(scanRoutes);
registerScanSignOutRoute(scanRoutes);
registerScanRoleRoutes(scanRoutes);
registerScanDraftRoutes(scanRoutes);
registerScanTagRoutes(scanRoutes);
registerScanSessionHoursRoutes(scanRoutes);
registerScanEnrollmentRoutes(scanRoutes);
registerScanOfflineRoutes(scanRoutes);
registerScanBrandingRoute(scanRoutes);
registerScanPhotoRoute(scanRoutes);
registerScanHistoryRoutes(scanRoutes);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/activity',
    summary: 'Recent activity on this scanning session',
    query: z.object({ problems: z.enum(['1']).optional() }),
    response: SessionActivitySchema,
  },
  async (c) => {
    const { problems } = c.req.valid('query');
    return c.json(await sessionActivityFor(serviceContext(c), scanActorOf(c), problems === '1'));
  },
);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/devices',
    summary: "This session's scanners and who is connected",
    response: SessionDevicesSchema,
  },
  async (c) => c.json(await sessionDevicesFor(serviceContext(c), scanActorOf(c))),
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
      actor.scanner ? { id: await liveReadyId(actor.scanner.id, req.idempotencyKey) } : {},
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
    // The door asks which bundle only for a pass that is in one (read with the pass, no extra trip).
    const shown = evaluatedSnapshot?.inBundle ? { ...outcome, inBundle: true } : outcome;
    return c.json(await withParentHint(ctx.env.DB, actor.orgId, shown));
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
      updatedSince: z.coerce.number().int().nonnegative().optional(),
      scope: ScanSummaryScopeSchema.default('device'),
    }),
    response: ScanSummarySchema,
  },
  async (c) => {
    const { since, updatedSince, scope } = c.req.valid('query');
    return c.json(
      await summaryFor(serviceContext(c), scanActorOf(c), updatedSince ?? since, scope),
    );
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
