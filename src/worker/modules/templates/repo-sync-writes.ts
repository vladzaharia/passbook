import type { Grant } from '../../platform/authority.ts';
import { inList, maxNow } from '../../platform/authority-expr.ts';
import type { NewVersion } from './repo.ts';
import { versionStatementSql } from './repo.ts';
import { adoptionUnchanged } from './repo-grant-checks.ts';
import { grantRow, inGrant } from './repo-grants.ts';
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
  'created_at',
  'updated_at',
];

/** Creates a baked org on first sight (the caller read that the slug was free). */
export function addBakedOrg(g: Grant, o: { id: string; slug: string; name: string; now: number }) {
  g.insertSelect(
    'orgs',
    ['id', 'slug', 'name', 'created_at', 'updated_at'],
    [o.id, o.slug, o.name, o.now, o.now],
  );
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
    existing.styles === styles;
  if (!same)
    g.update('templates', {
      set: {
        name: t.name,
        description: t.description,
        active_version: t.version,
        status: 'active',
        styles,
        updated_at: maxNow(t.now),
      },
      where: { id: t.id, origin: 'baked' },
      require: 'one',
    });
}

/** Baked templates that left the build are archived, not deleted. */
export function addArchiveStale(g: Grant, ids: readonly string[], now: number): void {
  for (let i = 0; i < ids.length; i += 20)
    g.update('templates', {
      set: { status: 'archived', updated_at: maxNow(now) },
      where: { id: inList(ids.slice(i, i + 20)), origin: 'baked', status: 'active' },
    });
}

/** The immutable version row (inserted once) and the read-back that proves its content is unchanged. */
export function addVersion(g: Grant, v: NewVersion): void {
  const [insert, verify] = versionStatementSql(v);
  const gate = grantRow(g);
  g.add(inGrant(g, `${insert.sql} AND ${gate.sql}`, [...insert.params, ...gate.params]));
  g.add(inGrant(g, verify.sql, verify.params));
}
