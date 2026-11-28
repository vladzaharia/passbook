import { PRESENT } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIdSql, usedRelease } from './effective-release.ts';
import type { LookupEntry } from './lookup-history.ts';
import { RACE_KEYSET } from './race-tags.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';
import { refsClear } from './repo-read-fences.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';

/** One row per entry, by position: 0 not visible, 1 visible, 2 visible at the image generation read. */
export interface LookupPassRow {
  i: number;
  pass_ok: number;
  /** The pass row is still there (in the actor's tenant). */
  present: number;
  head: string | null;
}

/**
 * The passes a lookup page answers about, in one statement under the actor's authority: each is live at
 * the credential and lifecycle generations it was read at, no transfer pending, its template and
 * connection usable, under the release it was used under, inside the actor's scope, and the searched
 * credential not retired. `head` is the pass's effective release now, so a release that changed how the
 * pass is used can be told from a pass that is gone. No row comes back when the actor's authority fails.
 */
export function lookupPassesStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  entries: readonly LookupEntry[],
  refs: readonly string[],
): D1PreparedStatement | null {
  const scope = actorPassScopeSql(actor, 'p');
  const cleared = refsClear(refs, { org: 'p.org_id', mode: 'p.mode' });
  if (!scope || !cleared) return null;
  const ring = JSON.stringify(
    entries.map((entry, i) => {
      const release = usedRelease(entry.source.templateSnapshot?.raw);
      const { pass } = entry.source;
      return [
        i,
        // A release that cannot be read cannot be confirmed: the pass id is withheld.
        release === false ? null : pass.id,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.imageGeneration,
        release ? release[0] : null,
      ];
    }),
  );
  const params: SqlValue[] = [...scope.params, ...cleared.params];
  return scanRead(
    db,
    auth,
    `SELECT ring.i AS i,
      CASE WHEN p.id IS NULL THEN 0 WHEN p.image_generation = ring.img THEN 2 ELSE 1 END AS pass_ok,
      hp.id IS NOT NULL AS present,
      CASE WHEN hp.id IS NULL THEN NULL ELSE ${effectiveReleaseIdSql('hp')} END AS head
    FROM ${auth.rows}ring
      LEFT JOIN passes p ON p.id = ring.pass_id AND ${auth.tenantOnce('p', 'passes')}
        AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
        AND ${scope.sql} AND ${cleared.sql} AND ${effectiveReleaseIdSql('p')} IS ring.rel
      LEFT JOIN passes hp ON hp.id = ring.pass_id AND ${auth.tenantOnce('hp', 'passes')}
    WHERE ${PRESENT} = 1`,
    params,
    {
      ctes: `ring AS MATERIALIZED (SELECT json_extract(value,'$[0]') AS i,
        json_extract(value,'$[1]') AS pass_id, json_extract(value,'$[2]') AS cred,
        json_extract(value,'$[3]') AS life, json_extract(value,'$[4]') AS img,
        json_extract(value,'$[5]') AS rel FROM json_each(?))`,
      params: [ring],
    },
  );
}

/** The gate of a lookup's first search: the actor's authority holds, and the keyset stored is the one in the database. */
export const lookupGateStmt = (db: D1Database, auth: ScanReadAuthority) =>
  scanRead(
    db,
    auth,
    `${RACE_KEYSET}
    SELECT ${auth.authorized('authorized')},
      (SELECT commitment FROM credential_ref_keyset WHERE id = 1) AS keyset FROM ${auth.anchor}`,
  );
