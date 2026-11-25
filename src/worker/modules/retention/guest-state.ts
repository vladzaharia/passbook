import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';

const CURSORS = 'retention.guestPassesCursors';

/**
 * Where each scan stopped last run (`''` is the platform pass, else an org id) as [template id, pass id], so a
 * backlog cannot starve later passes.
 */
export type Cursors = Record<string, [string, string]>;

export async function readCursors(ctx: ServiceContext): Promise<Cursors> {
  const stored = await readSystemValue(ctx.env.DB, CURSORS);
  return stored && typeof stored === 'object' ? (stored as Cursors) : {};
}

export const writeCursors = (ctx: ServiceContext, cursors: Cursors) =>
  writeSystemValue(ctx.env.DB, CURSORS, cursors, ctx.clock.now());
