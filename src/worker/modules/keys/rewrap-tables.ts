import { credentialAad } from '../../platform/crypto.ts';
import type { PlaceTable, Raw } from './repo-rewrap.ts';

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
];

/** Captured test emails keep their envelope packed in the body (sandbox/captured-body.ts). */
export const CAPTURE_TABLE = 'captured_emails';
export const captureAad = (id: string, orgId: string) => credentialAad(id, orgId, 'captured-email');

/** Every table that holds an envelope the job moves, in the order it sweeps them. */
export const ENVELOPE_TABLES: readonly string[] = [...PLACES.map((p) => p.table), CAPTURE_TABLE];
