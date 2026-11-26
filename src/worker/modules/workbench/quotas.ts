import type { Quotas } from '../../../shared/contracts/workbench-read.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { testPassCount } from '../developer/repo-home.ts';
import { endpointsHeld, keysHeld, templatesHeld } from './repo-summary.ts';

const cap = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** What a sandbox holds against the caps of its plan. */
export async function quotasOf(ctx: ServiceContext, orgId: string): Promise<Quotas> {
  const db = ctx.env.DB;
  const [e, passes, templates, endpoints, keys] = await Promise.all([
    entitlementsOf(ctx, orgId),
    testPassCount(db, orgId),
    templatesHeld(db, orgId),
    endpointsHeld(db, orgId),
    keysHeld(db, orgId, ctx.clock.now()),
  ]);
  return {
    passes: { used: passes, limit: cap(e['passes.test']) },
    templates: { used: templates, limit: cap(e.templates) },
    endpoints: { used: endpoints, limit: cap(e['webhooks.endpoints']) },
    keys: { used: keys, limit: cap(e['api.keys']) },
  };
}
