import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import {
  ScanMarkOutRequestSchema,
  ScanOverrideNoteRequestSchema,
  ScanOverrideRequestSchema,
} from '../../../shared/contracts/scan-occupancy.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deepFreeze } from './freeze.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { publishScan } from './live.ts';
import { markOut } from './occupancy/mark-out.ts';
import { setOverrideNote } from './override-note.ts';
import { overrideScan } from './overrides.ts';
import { capturingContext } from './scan-capture.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Occupancy actions on the device API: a Desk-actions monitor may call them too. */
export function registerScanOccupancyRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  // Overrides need a signed-in person (no `staffOptional`) and, on a monitor, Desk actions on.
  const actor = requireScanActor({ capability: 'passes:operate', screenActions: true });
  for (const path of ['/mark-out', '/overrides', '/overrides/*']) scanRoutes.use(path, actor);
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/mark-out',
      summary: 'Mark someone as out',
      body: ScanMarkOutRequestSchema,
      response: ScanOutcomeSchema,
    },
    async (c) =>
      c.json(
        await markOut(
          serviceContext(c),
          deepFreeze(cloneObservedScanActor(scanActorOf(c))),
          c.req.valid('json'),
        ),
      ),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/overrides',
      summary: 'Let in a held or refused scan',
      body: ScanOverrideRequestSchema,
      response: ScanOutcomeSchema,
    },
    async (c) => {
      const ctx = capturingContext(serviceContext(c));
      const who = deepFreeze(cloneObservedScanActor(scanActorOf(c)));
      const result = await overrideScan(ctx, who, deepFreeze(c.req.valid('json')));
      // A monitor's override reaches the refusing door by `resolved`; only a scanning device has a live row.
      if (!result.outcome.replay && who.scanner?.deviceRole === 'scan')
        publishScan(
          ctx,
          who,
          result.outcome,
          result.evaluatedSnapshot,
          result.credentialContext,
          'manual',
        );
      return c.json(result.outcome);
    },
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/overrides/{scanId}/note',
      summary: 'Say why they were let in',
      params: z.object({ scanId: z.string().min(1).max(64) }),
      body: ScanOverrideNoteRequestSchema,
      status: 204,
    },
    async (c) => {
      await setOverrideNote(
        serviceContext(c),
        deepFreeze(cloneObservedScanActor(scanActorOf(c))),
        c.req.valid('param').scanId,
        c.req.valid('json').note,
      );
      return c.body(null, 204);
    },
  );
}
