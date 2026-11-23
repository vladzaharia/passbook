// Single-purpose file: every grant here is `platform.entitlement_preset.update`, written by a live platform admin.
import { grant } from '../../platform/authority.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';

/** Organizations on `preset` whose features an earlier edit has not reached (a suspended org moves too; a deleted one does not). */
export const pendingOrgs = (db: D1Database, preset: string, revision: number, limit: number) =>
  all<{ org_id: string; revision: number; preset_revision: number }>(
    db,
    `SELECT e.org_id, e.revision, e.preset_revision FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
     WHERE e.preset = ? AND e.preset_revision < ? AND o.status != 'deleted' ORDER BY e.org_id LIMIT ?`,
    [preset, revision, limit],
  );

export const pendingCounts = async (db: D1Database): Promise<Map<string, number>> =>
  new Map(
    (
      await all<{ preset: string; n: number }>(
        db,
        `SELECT e.preset, count(*) AS n FROM org_entitlements e
         JOIN entitlement_preset_meta m ON m.preset = e.preset JOIN orgs o ON o.id = e.org_id
         WHERE e.preset_revision < m.revision AND o.status != 'deleted' GROUP BY e.preset`,
      )
    ).map((r) => [r.preset, r.n]),
  );

export const orgsOnPreset = async (db: D1Database, preset: string): Promise<number> =>
  (
    await first<{ n: number }>(db, 'SELECT count(*) AS n FROM org_entitlements WHERE preset = ?', [
      preset,
    ])
  )?.n ?? 0;

export const pendingCount = async (db: D1Database, preset: string, revision: number) =>
  (
    await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
       WHERE e.preset = ? AND e.preset_revision < ? AND o.status != 'deleted'`,
      [preset, revision],
    )
  )?.n ?? 0;

export interface PresetWrite {
  admin: { userId: string; sessionId: string };
  preset: string;
  /** The revision read; the edit commits only while it still stands. */
  expectedRevision: number;
  now: number;
  /** The preset as it stood, as JSON: what a move that stops part-way resumes from. */
  previousValues: string;
  changes: { key: string; value: string }[];
  audit: AuditEntry;
}

/**
 * `platform.entitlement_preset.update`: the changed values, the revision and the audit row commit in one
 * batch, and only while `revision` is the one the caller read (`ENTITLEMENTS_CHANGED` otherwise, nothing written).
 */
export async function writePreset(ctx: ServiceContext, w: PresetWrite): Promise<void> {
  const g = grant(ctx, {
    purpose: 'platform.entitlement_preset.update',
    principal: { kind: 'platform', userId: w.admin.userId, sessionIdHash: w.admin.sessionId },
    codes: { lineage: 'ENTITLEMENTS_CHANGED' },
  });
  g.update('entitlement_preset_meta', {
    set: { updated_at: w.now, updated_by: w.admin.userId, previous_values: w.previousValues },
    inc: ['revision'],
    where: { preset: w.preset, revision: w.expectedRevision },
    require: 'one',
  });
  for (const c of w.changes)
    g.update('entitlement_presets', {
      set: { value: c.value },
      where: { preset: w.preset, key: c.key },
      require: 'one',
    });
  grantedAudit(g, ctx, w.audit);
  await g.commit();
}
