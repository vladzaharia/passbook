import { credentialAad } from '../../platform/crypto.ts';
import { tagKeyKind, versionKind } from '../nfc/keyset-seal.ts';
import { adminKind, programKind } from '../nfc/program-seal.ts';
import { googleMessageAad } from '../wallet-providers/google-message-aad.ts';

export type PlaceTable =
  | 'credentials'
  | 'pass_personalizations'
  | 'apns_keys'
  | 'connection_webhook_retention'
  | 'connection_webhook_legacy_sources'
  | 'wallet_provider_credentials'
  | 'wallet_provider_instance_outcomes'
  | 'wallet_google_messages'
  | 'wallet_samsung_fetch_refs'
  | 'wallet_samsung_callback_receipts'
  | 'wallet_google_callback_receipts'
  | 'pass_credential_transfer_payloads'
  | 'pass_token_seals'
  | 'pass_auth_seals'
  | 'bundle_token_seals'
  | 'join_link_seals'
  | 'webhook_endpoint_secrets'
  | 'wallet_credential_versions'
  | 'wallet_provider_accounts'
  | 'nfc_tag_keys'
  | 'nfc_tag_sun'
  | 'nfc_tag_programs'
  | 'nfc_tag_admin_keys';

/** What a select returns: the key, the envelope's KEK and wrapped DEK, and up to four AAD inputs. */
export interface Raw {
  pk: string;
  kek_version: number;
  wrapped_dek: ArrayBuffer | number[];
  x1: string | number | null;
  x2: string | number | null;
  x3: string | number | null;
  x4: string | number | null;
}

/**
 * The envelope places cron keys.rewrap moves: a table with `kek_version, iv, wrapped_dek, ciphertext`,
 * and how each row's AAD is built. A wrong AAD makes the unwrap fail, so a row that does not match is
 * counted unreadable and never written. rewrap-tables.test.ts fails for a table that has the four
 * columns, or a writer that encrypts, and is not listed here.
 */
export interface Place {
  table: PlaceTable;
  /** The AAD the writer used, from the select's columns (repo-rewrap.ts: x1..x4). */
  aad(row: Raw): string;
}

const text = (v: string | number | null): string | null => (v === null ? null : String(v));

export const PLACES: readonly Place[] = [
  {
    // x1 kind, x2 credentials.org_id, x3 the signing identity's org, x4 whether one exists: a signer
    // is opened with its identity's org (identities/db-resolver.ts), the rest with the credential's.
    table: 'credentials',
    aad: (r) =>
      credentialAad(
        r.pk,
        r.x4 === 1 && r.x1 === 'pass_signer' ? text(r.x3) : text(r.x2),
        String(r.x1),
      ),
  },
  {
    table: 'pass_personalizations',
    aad: (r) => credentialAad(r.pk, text(r.x1), 'personalization'),
  },
  { table: 'apns_keys', aad: (r) => credentialAad(r.pk, null, `apns_key:${r.x1}`) },
  {
    table: 'connection_webhook_retention',
    aad: (r) => credentialAad(r.pk, text(r.x1), 'connection.webhook'),
  },
  {
    table: 'connection_webhook_legacy_sources',
    aad: (r) => credentialAad(r.pk, text(r.x1), 'connection.webhook.legacy-inbox'),
  },
  {
    table: 'wallet_provider_credentials',
    aad: (r) => credentialAad(r.pk, text(r.x2), `wallet-provider:${r.x1}:${r.x3}:${r.x4}`),
  },
  {
    table: 'wallet_provider_instance_outcomes',
    aad: (r) => credentialAad(r.pk, text(r.x1), 'wallet.provider.outcome'),
  },
  {
    // x1 the instance: the AAD google-messages.ts sealed it under.
    table: 'wallet_google_messages',
    aad: (r) => googleMessageAad(String(r.x1), r.pk),
  },
  {
    table: 'wallet_samsung_fetch_refs',
    aad: (r) => credentialAad(r.pk, text(r.x1), `samsung-ref|${r.x2}|${r.x3}`),
  },
  {
    table: 'wallet_samsung_callback_receipts',
    aad: (r) => credentialAad(r.pk, text(r.x1), `samsung-callback|${r.x2}|${r.x3}`),
  },
  {
    table: 'wallet_google_callback_receipts',
    aad: (r) => credentialAad(r.pk, text(r.x1), `google-callback|${r.x2}|${r.x3}`),
  },
  {
    table: 'pass_credential_transfer_payloads',
    aad: (r) => credentialAad(r.pk, text(r.x1), `pass-credential-transfer:${r.x2}`),
  },
  { table: 'pass_token_seals', aad: (r) => credentialAad(r.pk, text(r.x1), 'pass-link') },
  { table: 'pass_auth_seals', aad: (r) => credentialAad(r.pk, text(r.x1), 'apple-auth') },
  { table: 'bundle_token_seals', aad: (r) => credentialAad(r.pk, text(r.x1), 'bundle-link') },
  { table: 'join_link_seals', aad: (r) => credentialAad(r.pk, text(r.x1), 'join-link') },
  {
    // x1 org, x2 endpoint, x3 mode: webhooks/secrets.ts secretAad.
    table: 'webhook_endpoint_secrets',
    aad: (r) => credentialAad(r.pk, text(r.x1), `webhook_endpoint:${r.x2}:${r.x3}`),
  },
  {
    // x1 the credential's org (null for a platform credential), x2 its id, x3 scope, x4 `mode:provider`:
    // the AAD comes from the referencing credential row, never from the version.
    table: 'wallet_credential_versions',
    aad: (r) => credentialAad(r.pk, text(r.x1), `wallet-credential:${r.x2}:${r.x3}:${r.x4}`),
  },
  {
    // The enrolment's own HMAC key (hmac_* columns): x1 org, x2 mode, x3 provider. The account id is the
    // envelope id, so the envelope cannot be moved to another account, org, mode or provider.
    table: 'wallet_provider_accounts',
    aad: (r) => credentialAad(r.pk, text(r.x1), accountHmacKind(r.pk, String(r.x2), String(r.x3))),
  },
  {
    // Secure tag keys (nfc/keyset-seal.ts). x1 org, x2 mode, x3 keyset, x4 version; the row id is the AAD id.
    table: 'nfc_tag_keys',
    aad: (r) =>
      credentialAad(r.pk, text(r.x1), versionKind(String(r.x2), String(r.x3), String(r.x4))),
  },
  {
    // A supplier's per-tag file key: x1 org, x2 mode, x3 keyset; the tag id is the AAD id.
    table: 'nfc_tag_sun',
    aad: (r) => credentialAad(r.pk, text(r.x1), tagKeyKind(String(r.x2), String(r.x3))),
  },
  {
    // The intended keys of a tag being programmed (nfc/program-seal.ts): x1 org, x2 mode, x3 keyset; the row id is the AAD id.
    table: 'nfc_tag_programs',
    aad: (r) => credentialAad(r.pk, text(r.x1), programKind(String(r.x2), String(r.x3))),
  },
  {
    // The admin keys of a programmed tag: x1 org, x2 mode, x3 keyset; the tag id is the AAD id.
    table: 'nfc_tag_admin_keys',
    aad: (r) => credentialAad(r.pk, text(r.x1), adminKind(String(r.x2), String(r.x3))),
  },
];

/** The AAD kind of an enrolment's HMAC envelope; the writer and the opener use it too. */
export const accountHmacKind = (accountId: string, mode: string, provider: string): string =>
  `wallet-account-hmac:${accountId}:${mode}:${provider}`;

/** The KEK version column of a place: the account table keeps its envelope in `hmac_*` columns. */
export const kekColumn = (table: string): string =>
  table === 'wallet_provider_accounts' ? 'hmac_kek_version' : 'kek_version';

/** Captured test emails keep their envelope packed in the body (sandbox/captured-body.ts). */
export const CAPTURE_TABLE = 'captured_emails';
export const captureAad = (id: string, orgId: string) => credentialAad(id, orgId, 'captured-email');

/** Every table that holds an envelope the job moves, in the order it sweeps them. */
export const ENVELOPE_TABLES: readonly string[] = [...PLACES.map((p) => p.table), CAPTURE_TABLE];

/** `1>2`, `1,2>3`: the KEK versions below the current one, then the current one. The pair a sweep belongs to. */
export function stampOf(versions: readonly number[]): string {
  const sorted = [...versions].sort((a, b) => a - b);
  const current = sorted.at(-1);
  return `${sorted.slice(0, -1).join(',')}>${current ?? ''}`;
}
