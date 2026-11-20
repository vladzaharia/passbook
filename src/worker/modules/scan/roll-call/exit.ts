// A roll call Out also exits the person, and taking it back undoes that exit, through the same paths as Mark
// as out and its undo. Each runs the mark's own write inside the exit's or the undo's grant (`extra`), so the
// person and the mark change together or not at all.

import type { SessionAuth } from '../../../platform/auth.ts';
import type { Grant } from '../../../platform/authority.ts';
import { AppError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { UNDO_MAX_MS } from '../feed.ts';
import { deepFreeze } from '../freeze.ts';
import type { ScanActor } from '../guard.ts';
import { consoleMarkOut } from '../occupancy/console-inside.ts';
import { markOut } from '../occupancy/mark-out.ts';
import type { AdminAuthority } from '../repo-admin-grant.ts';
import { cloneObservedScanActor } from '../scanning-workspace-observation.ts';
import { consoleUndo, undo } from '../undo.ts';
import type { WithGrant } from './tables.ts';

export interface Exits {
  /** The exit's scan id once it committed with the mark; null when the person was already out (nothing written). */
  exit(passId: string, place: string, extra: WithGrant): Promise<string | null>;
  /** Undoes the exit with the mark's write in the same grant. Throws when the person has scanned since. */
  undoExit(scanId: string, extra: (g: Grant) => void): Promise<void>;
}

/** Someone else got there first: nothing to exit. */
const already = (error: unknown) => error instanceof AppError && error.code === 'NOT_INSIDE';

export function deviceExits(ctx: ServiceContext, actor: ScanActor): Exits {
  const who = () => deepFreeze(cloneObservedScanActor(actor));
  return {
    exit: async (passId, place, extra) => {
      try {
        const out = await markOut(
          ctx,
          who(),
          { idempotencyKey: ctx.ids.id(), passId, place },
          extra,
        );
        return out.scanId ?? null;
      } catch (error) {
        if (already(error)) return null;
        throw error;
      }
    },
    undoExit: async (scanId, extra) => {
      await undo(ctx, who(), scanId, { idempotencyKey: ctx.ids.id() }, UNDO_MAX_MS, extra);
    },
  };
}

/** Signed-in console users only: an API key has no mark-out path, so its Out is a confirmation alone. */
export function consoleExits(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: AdminAuthority,
): Exits {
  return {
    exit: async (passId, place, extra) => {
      const kind = place.startsWith('event:') ? 'event' : 'zone';
      const t = { kind, id: place.slice(place.indexOf(':') + 1) } as const;
      try {
        return await consoleMarkOut(ctx, authority.userId, authority, t, { passId, place }, extra);
      } catch (error) {
        if (already(error)) return null;
        throw error;
      }
    },
    undoExit: async (scanId, extra) => {
      await consoleUndo(ctx, session, {
        scanId,
        orgId: authority.orgId,
        mode: authority.mode,
        idempotencyKey: ctx.ids.id(),
        maxAgeMs: UNDO_MAX_MS,
        extra,
      });
    },
  };
}
