import type { Grant } from '../../platform/authority.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { readPart, writePart } from '../../platform/authority-include.ts';
import { addOrgEntitlements } from '../../platform/entitlements.ts';
import { RACE_TEMPLATE_VERSION_INSERT } from '../scan/race-tags.ts';
import type { NewVersion } from './repo.ts';
import { versionStatementSql } from './repo.ts';
import { adoptionUnchanged } from './repo-grant-checks.ts';
import {
  ADOPTION_KEY,
  type BakedAdoptionSnapshot,
  type BakedTemplateSnapshot,
  HASH_KEY,
} from './repo-sync.ts';

export interface BakedTemplateRow {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  styles: unknown;
  blueprint: boolean;
  now: number;
}

// A platform grant owns no tenant column, so a baked template names its org itself.
const TEMPLATE_COLUMNS = [
  'id',
  'org_id',
  'slug',
  'name',
  'description',
  'origin',
  'active_version',
  'status',
  'styles',
  'blueprint',
  'created_at',
  'updated_at',
];

/** Creates a baked org (and its `legacy` entitlements row) on first sight (the caller read that the slug was free). */
export function addBakedOrg(g: Grant, o: { id: string; slug: string; name: string; now: number }) {
  g.insertSelect(
    'orgs',
    ['id', 'slug', 'name', 'created_at', 'updated_at'],
    [o.id, o.slug, o.name, o.now, o.now],
  );
  addOrgEntitlements(g, o.id, 'legacy', o.now);
}

/** The adoption marker moves only from the value this build read; the hash follows it. */
export function addAdoption(g: Grant, value: string, hash: string, now: number): void {
  const columns = ['scope', 'key', 'value', 'updated_at'];
  g.upsert('settings', columns, ['system', ADOPTION_KEY, value, now], {
    update: ['value', 'updated_at'],
  });
  g.upsert('settings', columns, ['system', HASH_KEY, JSON.stringify(hash), now], {
    update: ['value', 'updated_at'],
  });
}

export function adoptionCheck(snapshot: BakedAdoptionSnapshot) {
  return adoptionUnchanged({
    adoptionKey: ADOPTION_KEY,
    hashKey: HASH_KEY,
    value: snapshot.value,
    legacy: snapshot.legacy,
    legacyUpdatedAt: snapshot.legacyUpdatedAt,
  });
}

/** Inserts a new baked template, or rewrites one whose catalogue fields differ from the build's. */
export function addBakedTemplate(
  g: Grant,
  t: BakedTemplateRow,
  existing: BakedTemplateSnapshot | null,
): void {
  const styles = JSON.stringify(t.styles);
  // A starter an org holds is that org's template; only platform-owned rows are blueprints.
  const blueprint = t.blueprint && (existing ? existing.org_id : t.orgId) === null ? 1 : 0;
  if (!existing) {
    g.insertSelect('templates', TEMPLATE_COLUMNS, [
      t.id,
      t.orgId,
      t.slug,
      t.name,
      t.description,
      'baked',
      t.version,
      'active',
      styles,
      blueprint,
      t.now,
      t.now,
    ]);
    return;
  }
  const same =
    existing.name === t.name &&
    existing.description === t.description &&
    existing.active_version === t.version &&
    existing.status === 'active' &&
    existing.styles === styles &&
    existing.blueprint === blueprint;
  if (!same)
    g.update('templates', {
      set: {
        name: t.name,
        description: t.description,
        active_version: t.version,
        status: 'active',
        styles,
        blueprint,
        updated_at: maxNow(t.now),
      },
      where: { id: t.id, origin: 'baked' },
      require: 'one',
    });
}

/** Baked templates that left the build are archived, not deleted; the stale set is read when the statement runs. */
export function addArchiveStale(g: Grant, keepIds: readonly string[], now: number): void {
  g.update('templates', {
    set: { status: 'archived', updated_at: maxNow(now) },
    where: { origin: 'baked', status: 'active' },
    when: [
      tenantSql('{row}.id NOT IN (SELECT value FROM json_each(?))', [JSON.stringify(keepIds)]),
    ],
  });
}

/** The immutable version row (inserted once) and the read-back that proves its content is unchanged. */
export function addVersion(g: Grant, v: NewVersion): void {
  const [insert, verify] = versionStatementSql(v);
  g.include(writePart(`${insert.sql} AND {grant}`, insert.params, RACE_TEMPLATE_VERSION_INSERT));
  g.include(readPart(`${verify.sql} WHERE {grant}`, verify.params));
}
