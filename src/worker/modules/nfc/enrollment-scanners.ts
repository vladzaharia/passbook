import type { TagScanner } from '../../../shared/contracts/nfc-tag-enrollments.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanHub } from '../scan/live.ts';
import { enrollScanners, type ScannerFacts } from './repo-enrollments.ts';
import type { SessionTagAuthority } from './repo-tags-write.ts';

function unavailable(f: ScannerFacts, online: boolean): TagScanner['unavailable'] {
  if (!online) return 'offline';
  if (!f.nfcTags) return 'no_tags';
  // A door reader never takes a request; nor does a desk with assigning turned off.
  if (f.role === 'door' || f.assign === 'never') return 'requests_off';
  if (f.busy) return 'busy';
  return null;
}

async function connectedIds(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return new Set(await scanHub(ctx, a.orgId, a.mode).connected(ids));
}

/** Scan-role devices of the org and mode, with what an admin needs to pick one. */
export async function listEnrollScanners(
  ctx: ServiceContext,
  a: SessionTagAuthority,
): Promise<TagScanner[]> {
  const now = ctx.clock.now();
  const facts = await enrollScanners(ctx.env.DB, a.orgId, a.mode, a.userId, now);
  const online = await connectedIds(
    ctx,
    a,
    facts.map((f) => f.id),
  );
  return facts.map((f) => ({
    id: f.id,
    name: f.name,
    sessionName: f.sessionName,
    role: f.role,
    online: online.has(f.id),
    unavailable: unavailable(f, online.has(f.id)),
    secureOnly: false,
    lastUsedAt: f.lastUsedAt,
  }));
}
