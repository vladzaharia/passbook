import type { PlatformIdentityDto } from '../../../shared/contracts/identities.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDtos } from './dto.ts';
import { PLATFORM_IDENTITY_ID } from './env-identity.ts';
import { PLATFORM_SLOTS, type PlatformSlot, platformTarget } from './provision-platform.ts';
import { type IdentityRow, listIdentityRows } from './repo.ts';
import { findOpenRun } from './repo-runs.ts';

const SLOTS = Object.keys(PLATFORM_SLOTS) as PlatformSlot[];

const slotOf = (row: IdentityRow): PlatformSlot | null =>
  SLOTS.find((slot) => PLATFORM_SLOTS[slot].passType === row.pass_type_identifier) ?? null;

async function registrationCounts(ctx: ServiceContext): Promise<Map<string, number>> {
  const rows = await all<{ identity_id: string; n: number }>(
    ctx.env.DB,
    `SELECT identity_id, count(*) AS n FROM registrations
     WHERE identity_id IN (SELECT id FROM signing_identities WHERE org_id IS NULL)
     GROUP BY identity_id`,
  );
  return new Map(rows.map((r) => [r.identity_id, r.n]));
}

/** The platform's own identities (no org): legacy, root and devtest, with their setup runs. */
export async function listPlatformIdentities(ctx: ServiceContext) {
  const rows = (await listIdentityRows(ctx.env.DB)).filter((r) => r.org_id === null);
  const dtos = await toDtos(ctx, rows);
  const registrations = await registrationCounts(ctx);
  const openRuns = { root: null, devtest: null } as Record<PlatformSlot, string | null>;
  for (const slot of SLOTS)
    openRuns[slot] =
      (await findOpenRun(ctx.env.DB, 'identity', platformTarget(slot), 'provision'))?.id ?? null;
  const items: PlatformIdentityDto[] = dtos.map((dto, i) => {
    const row = rows[i] as IdentityRow;
    const slot = slotOf(row);
    const legacy = row.id === PLATFORM_IDENTITY_ID;
    return {
      ...dto,
      slot,
      purpose: row.purpose,
      managed: row.source === 'env' ? 'deployment' : 'connector',
      registrationCount: registrations.get(row.id) ?? 0,
      openRunId: slot ? openRuns[slot] : null,
      dormant: legacy && !dto.isDefault && dto.passCount === 0,
    };
  });
  return { items, openRuns };
}
