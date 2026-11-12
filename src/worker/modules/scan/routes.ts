import { routePath } from 'hono/route';
import { z } from 'zod';
import {
  ScanActRequestSchema,
  ScanCountsSchema,
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
} from '../../../shared/contracts/scan-session.ts';
import {
  ReportScanDeviceSchema,
  ScanWorkspaceSchema,
  SessionActivitySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import { act } from './act.ts';
import { snapshotActionContext } from './act-snapshot.ts';
import { planCounts } from './counts.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { recentFor, summaryFor } from './history.ts';
import { publishScan } from './live.ts';
import { lookup } from './lookup.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import {
  packedScanAuthorityPredicate,
  sessionReadAuthorityPredicate,
} from './repo-session-authority.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { registerScanAssetRoute } from './routes-assets.ts';
import { registerScanBrandingRoute } from './routes-branding.ts';
import { registerScanStaffRoutes } from './routes-staff-session.ts';
import { reportScanDevice } from './scanning-workspace.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { buildSession } from './session.ts';
import { sessionActivityFor } from './session-activity.ts';
import { undo } from './undo.ts';

/** Device API: /api/v1/scan. */
export const scanRoutes = createRouter();

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
scanRoutes.use('/staff', requireScanActor({ capability: 'scanning:manage', staffOptional: true }));
scanRoutes.use('/actions', (c, next) =>
  (c.req.method === 'POST' ? operateActor : manageActor)(c, next),
);
for (const path of ['/summary', '/stats', '/activity', '/passes/*'])
  scanRoutes.use(path, (c, next) => (c.req.method === 'GET' ? readActor : manageActor)(c, next));
for (const path of ['/resolve', '/lookup'])
  scanRoutes.use(path, (c, next) => (c.req.method === 'POST' ? readActor : manageActor)(c, next));
// Hono's /scans/* also matches /scans itself, so choose exactly one guard here.
scanRoutes.use('/scans/*', (c, next) => {
  const suffix = c.req.path.slice(routePath(c).length - 2);
  if (c.req.method === 'GET' && suffix === '') return readActor(c, next);
  if (c.req.method === 'POST' && /^\/[^/]+\/undo$/.test(suffix)) return operateActor(c, next);
  return manageActor(c, next);
});
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
    query: DayStart,
    response: ScanSessionSchema,
  },
  async (c) => {
    const session = await buildSession(
      serviceContext(c),
      scanActorOf(c),
      c.req.valid('query').dayStart,
    );
    const auth = c.var.auth;
    if (auth?.kind === 'session' || (auth?.kind === 'scanner' && auth.transport === 'cookie'))
      session.csrfToken = auth.csrfSecret;
    return c.json(session);
  },
);

registerScanStaffRoutes(scanRoutes);
registerScanBrandingRoute(scanRoutes);

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
    const ctx = snapshotActionContext(serviceContext(c)),
      actor = cloneObservedScanActor(scanActorOf(c)),
      req = c.req.valid('json');
    const { outcome, evaluatedSnapshot, credentialContext } = await resolveOutcome(ctx, actor, req);
    publishScan(
      ctx,
      actor,
      outcome,
      evaluatedSnapshot,
      credentialContext,
      req.input.method,
      false,
      'code' in req.input,
    );
    return c.json(outcome);
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
    const ctx = snapshotActionContext(serviceContext(c)),
      actor = cloneObservedScanActor(scanActorOf(c)),
      req = c.req.valid('json');
    const { outcome, evaluatedSnapshot, credentialContext } = await act(ctx, actor, req);
    if (!outcome.replay)
      publishScan(
        ctx,
        actor,
        outcome,
        evaluatedSnapshot,
        credentialContext,
        req.input.method,
        false,
        'code' in req.input,
      );
    return c.json(outcome);
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
    query: z.object({ since: z.coerce.number().int().nonnegative().optional() }),
    response: ScanSummarySchema,
  },
  async (c) =>
    c.json(await summaryFor(serviceContext(c), scanActorOf(c), c.req.valid('query').since)),
);

register(
  scanRoutes,
  'scan',
  { method: 'get', path: '/stats', summary: 'Counts', query: DayStart, response: ScanCountsSchema },
  async (c) => {
    const source = serviceContext(c);
    const ctx = { ...source, env: { ...source.env } };
    const actor = cloneObservedScanActor(scanActorOf(c));
    // Counts are reads: no keyset bootstrap. The commitment only fences the expected-count cache write.
    actor.credentialKeysetCommitment = await credentialRefKeysetCommitment(
      captureCredentialKeyEnv(ctx.env),
    );
    // Epochs cover credential, configuration and staff changes; reads carry no CSRF proof.
    const authority = packedScanAuthorityPredicate(
      actor,
      sessionReadAuthorityPredicate(actor, ctx.clock.now()),
    );
    if (authority.sql === '0')
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    const plan = planCounts(ctx, actor, c.req.valid('query').dayStart, actor, authority);
    const results = await ctx.env.DB.batch([
      outputPredicateStmt(ctx.env.DB, authority),
      ...plan.stmts,
    ]);
    if ((results[0]?.results?.[0] as { authorized?: number } | undefined)?.authorized !== 1)
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    return c.json((await plan.read(results.slice(1))).counts);
  },
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
    const ctx = snapshotActionContext(serviceContext(c)),
      actor = cloneObservedScanActor(scanActorOf(c));
    const { outcome, evaluatedSnapshot, credentialContext } = await undo(
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
