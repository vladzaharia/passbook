import { first } from '../../platform/db.ts';

/** How a platform template reaches an org: shared with every org (or baked), or released by this org. */
export type PlatformOffer = false | 'open' | 'worked';

export const TEMPLATE_OWNER = {
  false: 't.org_id = {org}',
  open: "t.org_id IS NULL AND (t.origin = 'baked' OR t.shared = 1)",
  worked:
    't.org_id IS NULL AND EXISTS (SELECT 1 FROM template_releases vr WHERE vr.template_id = t.id AND vr.org_id = {org})',
} as const;

/** The offer of a platform template to this org, or null when the org may not see it. */
export async function platformOffer(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<'open' | 'worked' | null> {
  const t = await first<{ open: number; worked: number }>(
    db,
    `SELECT (t.origin = 'baked' OR t.shared = 1) AS open,
        EXISTS (SELECT 1 FROM template_releases vr WHERE vr.template_id = t.id AND vr.org_id = ?) AS worked
      FROM templates t WHERE t.id = ? AND t.org_id IS NULL`,
    [orgId, templateId],
  );
  return t?.open ? 'open' : t?.worked ? 'worked' : null;
}
