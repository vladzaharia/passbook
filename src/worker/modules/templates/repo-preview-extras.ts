import type { Grant } from '../../platform/authority.ts';
import { all, first } from '../../platform/db.ts';
import { candidateHash, ReleaseContentError } from './release-content.ts';
import { grantRow, inGrant } from './repo-grants.ts';

/** Immutable metadata for one versioned, non-bundle asset. */
export interface TemplateVersionExtra {
  name: string;
  size: number;
  sha1: string;
  sha256: string;
  r2Key: string;
}

export interface VersionExtrasSnapshot {
  extras: TemplateVersionExtra[];
  seal: string | null;
}

/** The seal covers the entire set, including physical keys and the empty set. */
export function versionExtrasHash(extras: readonly TemplateVersionExtra[]): Promise<string> {
  return candidateHash(
    [...extras].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
}

/** Read the unsealed state as well, for the privileged baked-version backfill. */
export async function versionExtrasSnapshot(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<VersionExtrasSnapshot> {
  const extras = await all<TemplateVersionExtra>(
    db,
    `SELECT name, size, sha1, sha256, r2_key AS r2Key FROM template_version_extras
     WHERE template_id = ? AND version = ? ORDER BY name`,
    [templateId, version],
  );
  const row = await first<{ extras_hash: string }>(
    db,
    'SELECT extras_hash FROM template_version_extra_sets WHERE template_id = ? AND version = ?',
    [templateId, version],
  );
  return { extras, seal: row?.extras_hash ?? null };
}

/** Readers accept only complete, sealed baked sets; uploaded versions have no extras. */
export async function listVersionExtras(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<TemplateVersionExtra[]> {
  const snapshot = await versionExtrasSnapshot(db, templateId, version);
  const owner = await first<{ origin: string }>(db, 'SELECT origin FROM templates WHERE id = ?', [
    templateId,
  ]);
  if (!owner || (owner.origin !== 'baked' && owner.origin !== 'uploaded'))
    throw new ReleaseContentError('Template extra owner is malformed.');
  if (snapshot.seal !== null) {
    if (owner.origin !== 'baked' || snapshot.seal !== (await versionExtrasHash(snapshot.extras)))
      throw new ReleaseContentError('Template extra set does not match its immutable seal.');
    return snapshot.extras;
  }
  if (owner.origin !== 'uploaded' || snapshot.extras.length > 0)
    throw new ReleaseContentError('Template extra set is not sealed.');
  return [];
}

export function addVersionExtra(
  g: Grant,
  templateId: string,
  version: string,
  extra: TemplateVersionExtra,
): void {
  const gate = grantRow(g);
  g.add(
    inGrant(
      g,
      `INSERT INTO template_version_extras (template_id, version, name, size, sha1, sha256, r2_key)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql}`,
      [
        templateId,
        version,
        extra.name,
        extra.size,
        extra.sha1,
        extra.sha256,
        extra.r2Key,
        ...gate.params,
      ],
    ),
  );
}

export function sealVersionExtras(
  g: Grant,
  templateId: string,
  version: string,
  hash: string,
): void {
  const gate = grantRow(g);
  g.add(
    inGrant(
      g,
      `INSERT INTO template_version_extra_sets (template_id, version, extras_hash)
       SELECT ?, ?, ? WHERE ${gate.sql}`,
      [templateId, version, hash, ...gate.params],
    ),
  );
}
