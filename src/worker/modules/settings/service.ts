import type { z } from 'zod';
import { OrgSettingsSchema, PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** Stored values merged over schema defaults. Workstream g owns and may add caching. */
export async function getPlatformSettings(ctx: ServiceContext): Promise<PlatformSettings> {
  return PlatformSettingsSchema.parse(await readScope(ctx, 'platform'));
}

export async function getOrgSettings(ctx: ServiceContext, orgId: string): Promise<OrgSettings> {
  return OrgSettingsSchema.parse(await readScope(ctx, `org:${orgId}`));
}

async function readScope(ctx: ServiceContext, scope: string): Promise<Record<string, unknown>> {
  const rows = await all<{ key: string; value: string }>(
    ctx.env.DB,
    'SELECT key, value FROM settings WHERE scope = ?',
    [scope],
  );
  return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
}
