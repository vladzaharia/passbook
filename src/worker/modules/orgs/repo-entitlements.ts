// Single-purpose file: every grant here is `platform.org.entitlements_set`, written by a live platform admin.
// The authority-scope allowlist exempts this file from the "names org_id" lint on that basis; a tenant grant
// does not belong here.
import { grant } from '../../platform/authority.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';

export interface OrgEntitlementsRow {
  preset: string;
  revision: number;
  /** The preset revision the org was last aligned to; below the preset's, an edit is still moving it. */
  preset_revision: number;
  updated_at: number;
}

export interface OverrideRow {
  key: string;
  value: string;
  note: string | null;
  expires_at: number | null;
}

export interface PresetRow {
  preset: string;
  label: string;
  revision: number;
  updated_at: number;
  previous_values: string | null;
  org_count: number;
}

export const orgExists = async (db: D1Database, orgId: string): Promise<boolean> =>
  (await first<{ x: number }>(db, 'SELECT 1 AS x FROM orgs WHERE id = ?', [orgId])) !== null;

/** The `developer` preset belongs to developer orgs, and they take no other (a trigger holds the same). */
export const orgIsDeveloper = async (db: D1Database, orgId: string): Promise<boolean> =>
  (await first<{ x: number }>(db, "SELECT 1 AS x FROM orgs WHERE id = ? AND kind = 'developer'", [
    orgId,
  ])) !== null;

export const orgEntitlementsRow = (db: D1Database, orgId: string) =>
  first<OrgEntitlementsRow>(
    db,
    'SELECT preset, revision, preset_revision, updated_at FROM org_entitlements WHERE org_id = ?',
    [orgId],
  );

/** The overrides that stand now: an expired one resolves to nothing, so it is not listed. */
export const standingOverrides = (db: D1Database, orgId: string, now: number) =>
  all<OverrideRow>(
    db,
    `SELECT key, value, note, expires_at FROM org_entitlement_overrides
     WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key`,
    [orgId, now],
  );

/** Every preset with the organizations on it. */
export const presetRows = (db: D1Database) =>
  all<PresetRow>(
    db,
    `SELECT m.preset, m.label, m.revision, m.updated_at, m.previous_values, (SELECT count(*) FROM org_entitlements e WHERE e.preset = m.preset) AS org_count
     FROM entitlement_preset_meta m ORDER BY m.is_plan, m.preset`,
  );

/** Every stored override, expired ones too: a save removes what it does not keep, and the journal reads them. */
export const storedOverrides = (db: D1Database, orgId: string) =>
  all<OverrideRow>(
    db,
    'SELECT key, value, note, expires_at FROM org_entitlement_overrides WHERE org_id = ? ORDER BY key',
    [orgId],
  );

export const presetValueRows = (db: D1Database) =>
  all<{ preset: string; key: string; value: string }>(
    db,
    'SELECT preset, key, value FROM entitlement_presets',
  );

export interface EntitlementsWrite {
  orgId: string;
  admin: { userId: string; sessionId: string };
  /** The revision read; 0 creates the missing row instead of moving an existing one. */
  expectedRevision: number;
  preset: string;
  /** The preset's revision, which the org is now aligned to. */
  presetRevision: number;
  now: number;
  /** Keys whose override is removed (including an expired one still stored). */
  remove: string[];
  /** Overrides to insert or change, values as stored JSON. */
  put: { key: string; value: string; note: string | null; expiresAt: number | null }[];
  audit: AuditEntry;
}

/**
 * `platform.org.entitlements_set`: the preset, the overrides and the audit row commit in one batch, and only
 * while `revision` is still the one the caller read. Another save in between aborts the batch
 * (`ENTITLEMENTS_CHANGED`) with nothing written.
 */
export async function writeEntitlements(ctx: ServiceContext, w: EntitlementsWrite): Promise<void> {
  const who = w.admin.userId;
  const g = grant(ctx, {
    purpose: 'platform.org.entitlements_set',
    principal: { kind: 'platform', userId: who, sessionIdHash: w.admin.sessionId },
    target: w.orgId,
    codes: { lineage: 'ENTITLEMENTS_CHANGED' },
  });
  if (w.expectedRevision === 0)
    // An org that lost its row (an old build inserted it after 0134): the first save makes it.
    g.insertSelect(
      'org_entitlements',
      ['org_id', 'preset', 'updated_at', 'updated_by'],
      [w.orgId, w.preset, w.now, who],
    );
  else
    g.update('org_entitlements', {
      set: {
        preset: w.preset,
        preset_revision: w.presetRevision,
        updated_at: w.now,
        updated_by: who,
      },
      inc: ['revision'],
      where: { org_id: w.orgId, revision: w.expectedRevision },
      require: 'one',
    });
  if (w.remove.length > 0)
    g.delete('org_entitlement_overrides', {
      where: { org_id: w.orgId, key: inList(w.remove) },
    });
  for (const o of w.put)
    g.upsert(
      'org_entitlement_overrides',
      ['org_id', 'key', 'value', 'note', 'expires_at', 'updated_at', 'updated_by'],
      [w.orgId, o.key, o.value, o.note, o.expiresAt, w.now, who],
      { update: ['value', 'note', 'expires_at', 'updated_at', 'updated_by'] },
    );
  grantedAudit(g, ctx, w.audit);
  await g.commit();
}
