import { all, first } from '../../platform/db.ts';
import { NO_PENDING_TRANSFER } from './repo.ts';

type Db = D1Database;

export interface BundleRow {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  template_id: string;
  template_version: string;
  identity_id: string;
  object_key: string;
  object_size: number | null;
  version: number;
  revision: number;
  credential_generation: number;
  lifecycle_generation: number;
  link_generation: number;
}

// A pass already in someone's Wallet leaves the Add all bundle (re-adding stays per pass).
const notInWallet = (a: string) =>
  `NOT EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = ${a}.id)`;
const transferFree = (a: string) => NO_PENDING_TRANSFER.replaceAll('p.', `${a}.`);
const ACTIVE_ORG = "JOIN orgs AS o ON o.id = p.org_id AND o.status = 'active'";

/** The pass's current JSON: what its card says (voided, expirationDate). */
const passJson = (a: string) => `COALESCE((SELECT pv.pass_json FROM pass_versions pv
  WHERE pv.pass_id = ${a}.id AND pv.version <= ${a}.version AND pv.pass_json IS NOT NULL
  ORDER BY pv.version DESC LIMIT 1), ${a}.pending_pass_json)`;

/**
 * Not past its end, as the card reads it: only an ISO-shaped text counts (anything else is kept), and
 * a date with no time lasts to the end of that day. The one parameter after the owner is now (ms).
 */
const notExpired = (a: string) => `COALESCE(NOT (
    json_type(${passJson(a)}, '$.expirationDate') = 'text'
    AND json_extract(${passJson(a)}, '$.expirationDate') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'
    AND CAST(strftime('%s', json_extract(${passJson(a)}, '$.expirationDate')) AS INTEGER) * 1000
      + CASE WHEN length(json_extract(${passJson(a)}, '$.expirationDate')) = 10 THEN 86399999 ELSE 0 END < ?), 1)`;

/**
 * What Add all may bundle, for alias `a` (two parameters: the owner, then now in ms): the holder's
 * own passes that are active, not voided, not expired (a date with no end never expires), not in
 * Wallet, not mid-transfer. A date the card cannot read counts as unexpired, as the card does.
 */
const eligible = (a: string) => `${a}.owner_user_id = ? AND ${a}.status = 'active'
  AND ${a}.deleted_at IS NULL AND ${a}.removed_at IS NULL AND ${a}.test_data_quarantined = 0
  AND ${transferFree(a)} AND ${notInWallet(a)}
  AND COALESCE(json_extract(${passJson(a)}, '$.voided'), 0) = 0
  AND ${notExpired(a)}
  AND EXISTS (SELECT 1 FROM orgs AS og WHERE og.id = ${a}.org_id AND og.status = 'active')`;

/** Test passes bundle only when the holder has no live pass to add (a sandbox recipient). */
const BUNDLE_WHERE = `${eligible('p')} AND (p.mode = 'live' OR NOT EXISTS (
  SELECT 1 FROM passes AS q WHERE q.mode = 'live' AND ${eligible('q')}))`;

/** Every pass Add all would bundle, newest first: the snapshot's ordered ids. */
export const listBundleCandidates = (db: Db, userId: string, now: number) =>
  all<Pick<BundleRow, 'id' | 'org_id' | 'mode' | 'template_id' | 'template_version'>>(
    db,
    `SELECT p.id, p.org_id, p.mode, p.template_id, p.template_version
     FROM passes AS p ${ACTIVE_ORG} WHERE ${BUNDLE_WHERE} ORDER BY p.id DESC`,
    [userId, now, userId, now],
  );

/** One part, by id range from the snapshot: a pass leaving the set never shifts its neighbours. */
export const listBundlePasses = (
  db: Db,
  userId: string,
  now: number,
  range: { first: string; after: string | null },
  limit: number,
) =>
  all<BundleRow>(
    db,
    `SELECT p.id, p.org_id, p.mode, p.template_id, p.template_version, p.identity_id, p.object_key, p.object_size, p.version, p.revision,
       p.credential_generation, p.lifecycle_generation, p.link_generation
     FROM passes AS p ${ACTIVE_ORG}
     WHERE ${BUNDLE_WHERE} AND p.id <= ? ${range.after === null ? '' : 'AND p.id > ?'}
     ORDER BY p.id DESC LIMIT ?`,
    [userId, now, userId, now, range.first, ...(range.after === null ? [] : [range.after]), limit],
  );

/** Recheck each archive entry after its object read and before any bytes are emitted: still in the set. */
export const bundlePassIsCurrent = async (db: Db, userId: string, now: number, row: BundleRow) =>
  (await first(
    db,
    `SELECT 1 FROM passes AS p ${ACTIVE_ORG} WHERE ${BUNDLE_WHERE} AND p.id = ?
    AND p.object_key = ? AND p.object_size IS ? AND p.version = ? AND p.revision = ?
    AND p.credential_generation = ? AND p.lifecycle_generation = ? AND p.link_generation = ?`,
    [
      userId,
      now,
      userId,
      now,
      row.id,
      row.object_key,
      row.object_size,
      row.version,
      row.revision,
      row.credential_generation,
      row.lifecycle_generation,
      row.link_generation,
    ],
  )) !== null;
