import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { maskEmail, strictEmail } from '../../../shared/email.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { bump } from '../../platform/counters.ts';
import { ForbiddenError, RateLimitedError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { countMiss } from './misses.ts';
import { searchPasses } from './repo-search.ts';
import { scanPolicy } from './rules.ts';

export async function lookup(
  ctx: ServiceContext,
  actor: ScanActor,
  raw: string,
): Promise<z.infer<typeof ScanLookupResultSchema>> {
  if (!scanPolicy(policyActor(actor), { kind: 'search' }).allow)
    throw new ForbiddenError('Lookup is disabled for this scanner.', 'SCAN_LOOKUP_DISABLED');
  await enforceRateLimit(ctx.env, 'RL_SCAN_LOOKUP', actor.actorKey);
  const now = ctx.clock.now();
  const hour = now - (now % 3_600_000);
  const maximum = (await getPlatformSettings(ctx))['scan.lookupsPerHour'];
  if ((await bump(ctx.env.DB, `scan:lk:${actor.actorKey}`, hour)) > maximum)
    throw new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));
  const q = raw.trim();
  const email = strictEmail(q);
  const rows =
    (q.includes('@') && !email) || (!email && Array.from(q).length < 3)
      ? []
      : await searchPasses(ctx.env.DB, actor, email ?? q, email !== null);
  if (!rows.length) await countMiss(ctx, actor);
  await auditStmt(ctx.env.DB, ctx, {
    orgId: actor.orgId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    action: 'scan.lookup',
    detail: { count: Math.min(rows.length, 10) },
  }).run();
  return {
    items: rows.slice(0, 10).map((row) => ({
      passId: row.id,
      title: row.title ?? '',
      subtitle: row.subtitle,
      templateName: row.template_name,
      status:
        row.removed_at !== null
          ? 'removed'
          : row.status === 'voided'
            ? 'voided'
            : validityOf(JSON.parse(row.pass_json ?? '{}'), now).status,
      maskedEmail: row.holder_email ? maskEmail(row.holder_email) : null,
      photoUrl: null,
      doorState: null,
      lastScanAt: row.last_scan_at,
    })),
    more: rows.length > 10,
  };
}
