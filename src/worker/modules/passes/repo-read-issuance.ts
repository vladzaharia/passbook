import { first } from '../../platform/db.ts';
import { orgForPass } from '../orgs/repo.ts';

export interface PassOrg {
  id: string;
  slug: string;
  name: string;
  status: string;
  defaultIdentityId: string | null;
  /** Raw branding JSON; read it with readBranding. */
  branding: unknown;
}

export async function getOrg(db: D1Database, orgId: string): Promise<PassOrg | null> {
  const row = await orgForPass(db, orgId);
  if (!row) return null;
  let branding: unknown = {};
  try {
    branding = JSON.parse(row.branding ?? '{}');
  } catch {
    // The column has a json_valid CHECK; a bad value means no branding, never a failed build.
    branding = {};
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    defaultIdentityId: row.default_identity_id,
    branding,
  };
}

export async function getCreateTemplate(
  db: D1Database,
  id: string,
): Promise<{ orgId: string | null; status: string; activeVersion: string | null } | null> {
  const row = await first<{ org_id: string | null; status: string; active_version: string | null }>(
    db,
    'SELECT org_id, status, active_version FROM templates WHERE id = ?',
    [id],
  );
  return row ? { orgId: row.org_id, status: row.status, activeVersion: row.active_version } : null;
}
