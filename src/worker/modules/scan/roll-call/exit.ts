// A roll call Out also exits the person, through the same paths as Mark as out and its undo.

import type { Grant } from '../../../platform/authority.ts';
import { AppError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { deepFreeze } from '../freeze.ts';
import type { ScanActor } from '../guard.ts';
import { consoleMarkOut } from '../occupancy/console-inside.ts';
import { markOut } from '../occupancy/mark-out.ts';
import { entryPlan } from '../occupancy/rules.ts';
import { addEntry, occupancyZones } from '../occupancy/service.ts';
import type { AdminAuthority } from '../repo-admin-grant.ts';
import { cloneObservedScanActor } from '../scanning-workspace-observation.ts';
export interface Exits {
  /** The exit's scan id, or null when the person was already out. */
  exit(passId: string, place: string): Promise<string | null>;
}

/** Someone else got there first: nothing to exit. */
const already = (error: unknown) => error instanceof AppError && error.code === 'NOT_INSIDE';

export function deviceExits(ctx: ServiceContext, actor: ScanActor): Exits {
  const who = () => deepFreeze(cloneObservedScanActor(actor));
  return {
    exit: async (passId, place) => {
      try {
        const out = await markOut(ctx, who(), { idempotencyKey: ctx.ids.id(), passId, place });
        return out.scanId ?? null;
      } catch (error) {
        if (already(error)) return null;
        throw error;
      }
    },
  };
}

/** Signed-in console users only: an API key has no mark-out path, so its Out is a confirmation alone. */
export function consoleExits(ctx: ServiceContext, authority: AdminAuthority): Exits {
  return {
    exit: async (passId, place) => {
      const at = place.indexOf(':');
      const kind = place.startsWith('event:') ? 'event' : 'zone';
      try {
        return await consoleMarkOut(
          ctx,
          authority.userId,
          authority,
          { kind, id: place.slice(at + 1) },
          { passId, place },
        );
      } catch (error) {
        if (already(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Takes an Out back: the person goes back into the place through the occupancy builder (capacity and the
 * parent are not re-checked: they were in). False for an event place, a zone that no longer tracks, or when
 * the stay moved since.
 */
export async function reenter(
  ctx: ServiceContext,
  grantFor: (now: number) => Grant,
  orgId: string,
  passId: string,
  place: string,
): Promise<boolean> {
  if (!place.startsWith('zone:')) return false;
  const now = ctx.clock.now();
  const zones = await occupancyZones(ctx.env.DB, orgId);
  const waivers = { cap: true, parent: true, limit: true, wait: true };
  const plan = entryPlan(zones, place.slice(5), now, null, waivers);
  if (!plan) return false;
  const g = grantFor(now);
  addEntry(g, { passId, scanId: ctx.ids.id(), now, plan, waivers });
  await g.commit();
  return true;
}
