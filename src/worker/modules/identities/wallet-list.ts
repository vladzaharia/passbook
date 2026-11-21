import type { IdentityStatus, WalletIdentityDto } from '../../../shared/contracts/identities.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { loadRunStates } from './dto.ts';
import { type IdentityRow, pageIdentityRows, passCounts } from './repo.ts';
import { identityStatus } from './status.ts';

export interface WalletIdentityQuery {
  cursor?: string | undefined;
  limit: number;
  orgId?: string | undefined;
  kind?: IdentityRow['provenance'] | undefined;
  status?: IdentityStatus | undefined;
}

const BATCH = 100;

/** The status is computed, so it filters here: rows are read in batches until `limit` match or none are left. */
export async function listWalletIdentities(
  ctx: ServiceContext,
  query: WalletIdentityQuery,
): Promise<{ items: WalletIdentityDto[]; nextCursor: string | null }> {
  const items: WalletIdentityDto[] = [];
  const now = ctx.clock.now();
  let scanned = query.cursor;
  for (;;) {
    const rows = await pageIdentityRows(ctx.env.DB, scanned, BATCH, query.orgId, query.kind);
    if (rows.length === 0) return { items, nextCursor: null };
    const runs = await loadRunStates(ctx, rows);
    const counts = await passCounts(
      ctx.env.DB,
      rows.map((r) => r.id),
    );
    for (const [i, row] of rows.entries()) {
      const status = identityStatus(row, runs, now);
      scanned = row.id;
      if (query.status && status !== query.status) continue;
      items.push({
        id: row.id,
        provider: 'apple',
        orgId: row.org_id,
        label: row.label,
        identifier: row.pass_type_identifier,
        kind: row.provenance,
        status,
        notBefore: row.not_before,
        notAfter: row.not_after,
        rotation: row.rotation,
        nextRotationAt: row.next_rotation_at,
        issuing: row.issuing === 1,
        isDefault: row.is_default === 1,
        passCount: counts.get(row.id) ?? 0,
        createdAt: row.created_at,
      });
      if (items.length === query.limit)
        return {
          items,
          nextCursor: i < rows.length - 1 || rows.length === BATCH ? row.id : null,
        };
    }
    if (rows.length < BATCH) return { items, nextCursor: null };
  }
}
