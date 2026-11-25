import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';

export interface LapsedProgram {
  id: string;
  orgId: string;
  mode: Mode;
  hint: string;
  hasKeys: boolean;
}

/** Holds past their minute that no call has ended: their sessions are cleared by the sweep. */
export async function lapsedPrograms(
  db: D1Database,
  now: number,
  limit: number,
): Promise<LapsedProgram[]> {
  const rows = await all<{ id: string; org_id: string; mode: Mode; hint: string; keyed: number }>(
    db,
    `SELECT id, org_id, mode, hint, kek_version IS NOT NULL AS keyed FROM nfc_tag_programs
      WHERE state IN ('started', 'scripted') AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
    [now, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    hint: r.hint,
    hasKeys: r.keyed === 1,
  }));
}

/** Tenants with ended rows older than `before`. */
export async function purgeableProgramTenants(
  db: D1Database,
  before: number,
): Promise<{ orgId: string; mode: Mode }[]> {
  const rows = await all<{ org_id: string; mode: Mode }>(
    db,
    `SELECT DISTINCT org_id, mode FROM nfc_tag_programs
      WHERE updated_at < ? AND (state IN ('programmed', 'reset', 'abandoned') OR (state = 'failed' AND kek_version IS NULL))`,
    [before],
  );
  return rows.map((r) => ({ orgId: r.org_id, mode: r.mode }));
}
