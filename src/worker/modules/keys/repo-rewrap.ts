import { all, batch, type SqlValue, stmt } from '../../platform/db.ts';
import { GOOGLE_MESSAGES_SELECT, GOOGLE_MESSAGES_UPDATE } from './repo-rewrap-messages.ts';
import type { PlaceTable, Raw } from './rewrap-tables.ts';

// Raw writes of cron keys.rewrap: one literal statement per envelope place, pinned in
// tools/authority-scope-allowlists.ts. Each moves an envelope to a newer KEK (kek_version and wrapped_dek
// only) and matches only the exact envelope that was read, so a writer that replaced it in between wins
// and nothing is lost. Every guard that could make a trigger abort is repeated in the WHERE clause: an
// aborting statement would roll back its whole batch.

/** Rows after `after` (by key) whose envelope is under a KEK older than `current`. */
const SELECT: Record<PlaceTable, string> = {
  credentials: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.kind AS x1, t.org_id AS x2,
      (SELECT s.org_id FROM signing_identities s WHERE s.credential_id = t.id ORDER BY s.id LIMIT 1) AS x3,
      EXISTS (SELECT 1 FROM signing_identities s WHERE s.credential_id = t.id) AS x4
    FROM credentials t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  pass_personalizations: `SELECT t.pass_id AS pk, t.kek_version, t.wrapped_dek,
      (SELECT p.org_id FROM passes p WHERE p.id = t.pass_id) AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM pass_personalizations t WHERE t.pass_id > ? AND t.kek_version < ? ORDER BY t.pass_id LIMIT ?`,
  apns_keys: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.team_identifier AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM apns_keys t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  connection_webhook_retention: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM connection_webhook_retention t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  connection_webhook_legacy_sources: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM connection_webhook_legacy_sources t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_provider_credentials: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.account_id AS x1, t.org_id AS x2, t.mode AS x3, t.provider AS x4
    FROM wallet_provider_credentials t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_provider_instance_outcomes: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek,
      (SELECT i.org_id FROM wallet_provider_instance_operations o JOIN wallet_provider_instances i ON i.id = o.instance_id
        WHERE o.id = t.operation_id) AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM wallet_provider_instance_outcomes t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_google_messages: GOOGLE_MESSAGES_SELECT,
  wallet_samsung_fetch_refs: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek,
      (SELECT i.org_id FROM wallet_provider_instances i WHERE i.id = t.instance_id) AS x1,
      (SELECT i.mode FROM wallet_provider_instances i WHERE i.id = t.instance_id) AS x2,
      t.instance_id AS x3, NULL AS x4
    FROM wallet_samsung_fetch_refs t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_samsung_callback_receipts: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, t.mode AS x2, t.instance_id AS x3, NULL AS x4
    FROM wallet_samsung_callback_receipts t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_google_callback_receipts: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, t.mode AS x2, t.instance_id AS x3, NULL AS x4
    FROM wallet_google_callback_receipts t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  pass_credential_transfer_payloads: `SELECT t.transfer_id AS pk, t.kek_version, t.wrapped_dek,
      (SELECT x.org_id FROM pass_credential_transfers x WHERE x.id = t.transfer_id) AS x1,
      (SELECT x.mode FROM pass_credential_transfers x WHERE x.id = t.transfer_id) AS x2, NULL AS x3, NULL AS x4
    FROM pass_credential_transfer_payloads t WHERE t.transfer_id > ? AND t.kek_version < ? ORDER BY t.transfer_id LIMIT ?`,
  pass_token_seals: `SELECT t.pass_id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM pass_token_seals t WHERE t.pass_id > ? AND t.kek_version < ? ORDER BY t.pass_id LIMIT ?`,
  pass_auth_seals: `SELECT t.pass_id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM pass_auth_seals t WHERE t.pass_id > ? AND t.kek_version < ? ORDER BY t.pass_id LIMIT ?`,
  bundle_token_seals: `SELECT t.bundle_id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM bundle_token_seals t WHERE t.bundle_id > ? AND t.kek_version < ? ORDER BY t.bundle_id LIMIT ?`,
  join_link_seals: `SELECT t.link_id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM join_link_seals t WHERE t.link_id > ? AND t.kek_version < ? ORDER BY t.link_id LIMIT ?`,
  webhook_endpoint_secrets: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, t.endpoint_id AS x2, t.mode AS x3, NULL AS x4
    FROM webhook_endpoint_secrets t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_credential_versions: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, c.org_id AS x1, c.id AS x2, c.scope AS x3,
      c.mode || ':' || c.provider AS x4
    FROM wallet_credential_versions t JOIN wallet_credentials c ON c.id = t.credential_id
    WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  wallet_provider_accounts: `SELECT t.id AS pk, t.hmac_kek_version AS kek_version, t.hmac_wrapped_dek AS wrapped_dek,
      t.org_id AS x1, t.mode AS x2, t.provider AS x3, NULL AS x4
    FROM wallet_provider_accounts t WHERE t.id > ? AND t.hmac_kek_version < ? ORDER BY t.id LIMIT ?`,
  nfc_tag_keys: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, k.org_id AS x1, k.mode AS x2, t.keyset_id AS x3, t.version AS x4
    FROM nfc_tag_keys t JOIN nfc_tag_keysets k ON k.id = t.keyset_id
    WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  nfc_tag_sun: `SELECT t.tag_id AS pk, t.kek_version, t.wrapped_dek, k.org_id AS x1, k.mode AS x2, t.keyset_id AS x3, NULL AS x4
    FROM nfc_tag_sun t JOIN nfc_tag_keysets k ON k.id = t.keyset_id
    WHERE t.tag_id > ? AND t.kek_version < ? ORDER BY t.tag_id LIMIT ?`,
  nfc_tag_programs: `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.org_id AS x1, t.mode AS x2, t.keyset_id AS x3, NULL AS x4
    FROM nfc_tag_programs t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`,
  nfc_tag_admin_keys: `SELECT t.tag_id AS pk, t.kek_version, t.wrapped_dek, k.org_id AS x1, k.mode AS x2, t.keyset_id AS x3, NULL AS x4
    FROM nfc_tag_admin_keys t JOIN nfc_tag_keysets k ON k.id = t.keyset_id
    WHERE t.tag_id > ? AND t.kek_version < ? ORDER BY t.tag_id LIMIT ?`,
};

export function selectEnvelopes(
  db: D1Database,
  table: PlaceTable,
  after: string | null,
  current: number,
  limit: number,
): Promise<Raw[]> {
  return all<Raw>(db, SELECT[table], [after ?? '', current, limit]);
}

/** A move: the envelope as read, and the wrapped DEK under the newer KEK. */
export interface Move {
  pk: string;
  kek: number;
  wrapped: Uint8Array;
  nextKek: number;
  nextWrapped: Uint8Array;
}

const params = (m: Move): SqlValue[] => [m.nextKek, m.nextWrapped, m.pk, m.kek, m.wrapped];

/** One statement per place; `?` are next kek, next wrapped DEK, key, kek and wrapped DEK as read. */
const CAS: Record<PlaceTable, (db: D1Database, m: Move) => D1PreparedStatement> = {
  credentials: (db, m) =>
    stmt(
      db,
      `UPDATE credentials SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  pass_personalizations: (db, m) =>
    stmt(
      db,
      `UPDATE pass_personalizations SET kek_version = ?, wrapped_dek = ?
       WHERE pass_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING pass_id`,
      params(m),
    ),
  apns_keys: (db, m) =>
    stmt(
      db,
      `UPDATE apns_keys SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  connection_webhook_retention: (db, m) =>
    stmt(
      db,
      `UPDATE connection_webhook_retention SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  connection_webhook_legacy_sources: (db, m) =>
    stmt(
      db,
      `UPDATE connection_webhook_legacy_sources SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_provider_credentials: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_provider_credentials SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_provider_instance_outcomes: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_provider_instance_outcomes SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_google_messages: (db, m) => stmt(db, GOOGLE_MESSAGES_UPDATE, params(m)),
  wallet_samsung_fetch_refs: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_samsung_fetch_refs SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_samsung_callback_receipts: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_samsung_callback_receipts SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_google_callback_receipts: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_google_callback_receipts SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  pass_credential_transfer_payloads: (db, m) =>
    stmt(
      db,
      `UPDATE pass_credential_transfer_payloads SET kek_version = ?, wrapped_dek = ?
       WHERE transfer_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING transfer_id`,
      params(m),
    ),
  pass_token_seals: (db, m) =>
    stmt(
      db,
      `UPDATE pass_token_seals SET kek_version = ?, wrapped_dek = ?
       WHERE pass_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING pass_id`,
      params(m),
    ),
  pass_auth_seals: (db, m) =>
    stmt(
      db,
      `UPDATE pass_auth_seals SET kek_version = ?, wrapped_dek = ?
       WHERE pass_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING pass_id`,
      params(m),
    ),
  bundle_token_seals: (db, m) =>
    stmt(
      db,
      `UPDATE bundle_token_seals SET kek_version = ?, wrapped_dek = ?
       WHERE bundle_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING bundle_id`,
      params(m),
    ),
  join_link_seals: (db, m) =>
    stmt(
      db,
      `UPDATE join_link_seals SET kek_version = ?, wrapped_dek = ?
       WHERE link_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING link_id`,
      params(m),
    ),
  webhook_endpoint_secrets: (db, m) =>
    stmt(
      db,
      `UPDATE webhook_endpoint_secrets SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_credential_versions: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_credential_versions SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  wallet_provider_accounts: (db, m) =>
    stmt(
      db,
      `UPDATE wallet_provider_accounts SET hmac_kek_version = ?, hmac_wrapped_dek = ?
       WHERE id = ? AND hmac_kek_version = ? AND hmac_wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  nfc_tag_keys: (db, m) =>
    stmt(
      db,
      `UPDATE nfc_tag_keys SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  nfc_tag_sun: (db, m) =>
    stmt(
      db,
      `UPDATE nfc_tag_sun SET kek_version = ?, wrapped_dek = ?
       WHERE tag_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING tag_id`,
      params(m),
    ),
  nfc_tag_programs: (db, m) =>
    stmt(
      db,
      `UPDATE nfc_tag_programs SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`,
      params(m),
    ),
  nfc_tag_admin_keys: (db, m) =>
    stmt(
      db,
      `UPDATE nfc_tag_admin_keys SET kek_version = ?, wrapped_dek = ?
       WHERE tag_id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING tag_id`,
      params(m),
    ),
};

/** One D1 batch of compare-and-set moves; returns how many rows moved (the rest changed since they were read). */
async function moveEnvelopes(
  db: D1Database,
  table: PlaceTable,
  moves: readonly Move[],
): Promise<number> {
  const results = await batch(
    db,
    moves.map((m) => CAS[table](db, m)),
  );
  return results.reduce((n, r) => n + (r.results?.length ?? 0), 0);
}

// Captured test emails keep the envelope packed in the body: `enc1:<kek>.<iv>.<wrapped DEK>.<ciphertext>`.

export interface RawCapture {
  pk: string;
  org_id: string;
  html: string | null;
  text: string | null;
}

/** The first 200 characters of each sealed body hold the whole header (kek, iv, wrapped DEK). */
export const CAPTURE_HEAD = 200;

export function selectCaptures(
  db: D1Database,
  after: string | null,
  current: number,
  limit: number,
): Promise<RawCapture[]> {
  return all<RawCapture>(
    db,
    `SELECT t.id AS pk, t.org_id,
       CASE WHEN t.html GLOB 'enc1:*' THEN substr(t.html, 1, ${CAPTURE_HEAD}) END AS html,
       CASE WHEN t.text GLOB 'enc1:*' THEN substr(t.text, 1, ${CAPTURE_HEAD}) END AS text
     FROM captured_emails t
     WHERE t.id > ?
       AND ((t.html GLOB 'enc1:*' AND CAST(substr(t.html, 6, instr(t.html, '.') - 6) AS INTEGER) < ?)
         OR (t.text GLOB 'enc1:*' AND CAST(substr(t.text, 6, instr(t.text, '.') - 6) AS INTEGER) < ?))
     ORDER BY t.id LIMIT ?`,
    [after ?? '', current, current, limit],
  );
}

/** A capture's move: each column's header as read and its replacement ('' for a column left alone). */
export interface CaptureMove {
  pk: string;
  html: { from: string; to: string };
  text: { from: string; to: string };
}

/** Replaces the headers in place; the body is never read or bound. A forward in flight locks the row. */
async function moveCaptures(db: D1Database, moves: readonly CaptureMove[]): Promise<number> {
  const results = await batch(
    db,
    moves.map((m) =>
      stmt(
        db,
        `UPDATE captured_emails SET html = ? || substr(html, ?), text = ? || substr(text, ?)
         WHERE id = ? AND substr(html, 1, ?) = ? AND substr(text, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM sandbox_forwards f
             WHERE f.capture_id = captured_emails.id AND f.state IN ('sending', 'unknown'))
         RETURNING id`,
        [
          m.html.to,
          m.html.from.length + 1,
          m.text.to,
          m.text.from.length + 1,
          m.pk,
          m.html.from.length,
          m.html.from,
          m.text.from.length,
          m.text.from,
        ],
      ),
    ),
  );
  return results.reduce((n, r) => n + (r.results?.length ?? 0), 0);
}

/** The one entry for writes: a batch of moves for one place. */
export type MoveBatch =
  | { table: PlaceTable; moves: readonly Move[] }
  | { table: 'captured_emails'; moves: readonly CaptureMove[] };

export function moveRows(db: D1Database, batch: MoveBatch): Promise<number> {
  return batch.table === 'captured_emails'
    ? moveCaptures(db, batch.moves)
    : moveEnvelopes(db, batch.table, batch.moves);
}
