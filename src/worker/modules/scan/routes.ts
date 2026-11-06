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
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { openPublicAsset } from '../public/service.ts';
import { act } from './act.ts';
import { assetGrantValid } from './assets.ts';
import { planCounts } from './counts.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { recentFor, summaryFor } from './history.ts';
import { lookup } from './lookup.ts';
import { candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { buildSession } from './session.ts';
import { undo } from './undo.ts';

/** Device API: /api/v1/scan. Pairing and staff sign-in are other files; lookup and undo are later tasks. */
export const scanRoutes = createRouter();

// Admin scope rides the query on a GET (`?orgId&eventId&templateIds&timeZone`); the guard reads it.
const DayStart = z.object({ dayStart: z.coerce.number().int().nonnegative().optional() });
const AssetParams = z.object({
  passId: z.string().min(1).max(64),
  name: z.string().regex(/^[A-Za-z0-9_@.-]{1,100}\.png$/),
});

scanRoutes.use('/session', requireScanActor({ staffOptional: true, screens: true }));
for (const path of [
  '/resolve',
  '/actions',
  '/scans',
  '/summary',
  '/stats',
  '/passes/*',
  '/lookup',
  '/scans/*',
])
  scanRoutes.use(path, requireScanActor());
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
    if (c.var.auth?.kind === 'session') session.csrfToken = c.var.auth.csrfSecret;
    return c.json(session);
  },
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
  async (c) => c.json(await resolveOutcome(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
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
  async (c) => c.json(await act(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
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
    const ctx = serviceContext(c);
    const plan = planCounts(ctx, scanActorOf(c), c.req.valid('query').dayStart);
    const results = await ctx.env.DB.batch(plan.stmts);
    return c.json((await plan.read(results)).counts);
  },
);

register(
  scanRoutes,
  'scan',
  {
    method: 'get',
    path: '/passes/{passId}/assets/{name}',
    summary: 'Pass image, with a grant',
    params: AssetParams,
    query: z.object({ g: z.string().max(100).optional() }),
  },
  async (c) => {
    const ctx = serviceContext(c);
    const actor = scanActorOf(c);
    const { passId, name } = c.req.valid('param');
    const missing = () => new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    if (
      !(await assetGrantValid(
        ctx.env,
        actor.actorKey,
        passId,
        c.req.valid('query').g,
        ctx.clock.now(),
      ))
    )
      throw missing();
    const candidate = await candidateById(ctx.env.DB, actor.orgId, passId);
    if (!candidate || candidate.pass.mode !== actor.mode) throw missing();
    const asset = await openPublicAsset(ctx, candidate.pass, name);
    return new Response(asset.body, {
      headers: {
        'content-type': 'image/png',
        etag: asset.etag,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);

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
  async (c) =>
    c.json(
      await undo(
        serviceContext(c),
        scanActorOf(c),
        c.req.valid('param').scanId,
        c.req.valid('json'),
      ),
    ),
);
