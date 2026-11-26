import type { PlatformIdentityDto } from '../../../shared/contracts/identities.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDtos } from './dto.ts';
import { PLATFORM_IDENTITY_ID } from './env-identity.ts';
import { PLATFORM_SLOTS, type PlatformSlot, platformTarget } from './provision-platform.ts';
import { type IdentityRow, listIdentityRows } from './repo.ts';
import { platformRegistrationCounts } from './repo-platform-list.ts';
import { findOpenRun } from './repo-runs.ts';

const SLOTS = Object.keys(PLATFORM_SLOTS) as PlatformSlot[];

const slotOf = (row: IdentityRow): PlatformSlot | null =>
  SLOTS.find((slot) => PLATFORM_SLOTS[slot].passType === row.pass_type_identifier) ?? null;

/** The platform's own identities (no org): legacy, root and devtest, with their setup runs. */
export async function listPlatformIdentities(ctx: ServiceContext) {
  const rows = (await listIdentityRows(ctx.env.DB)).filter((r) => r.org_id === null);
  const dtos = await toDtos(ctx, rows);
  const registrations = await platformRegistrationCounts(ctx.env.DB);
  const openRuns: { slot: PlatformSlot; runId: string }[] = [];
  for (const slot of SLOTS) {
    const open = await findOpenRun(ctx.env.DB, 'identity', platformTarget(slot), 'provision');
    if (open) openRuns.push({ slot, runId: open.id });
  }
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
      openRunId: openRuns.find((o) => o.slot === slot)?.runId ?? null,
      dormant: legacy && !dto.isDefault && dto.passCount === 0,
    };
  });
  return { items, openRuns };
}
