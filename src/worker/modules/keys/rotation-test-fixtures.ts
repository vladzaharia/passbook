import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeScanStaff, withoutTrigger } from '../../../../test/helpers/index.ts';
import { credentialAad, type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { sealBody } from '../sandbox/captured-body.ts';
import type { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { CAPTURE_TABLE, ENVELOPE_TABLES } from './rewrap-tables.ts';

export type Samsung = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

/** Rows seeded by hand, with the AAD their writers use (copied from the writers, not from the registry). */
export interface Seeded {
  connectorId: string;
  webhookCredentialId: string;
  signerCredentialId: string;
  signerCertSha: string;
  team: string;
  personalizedPassId: string;
  retentionId: string;
  legacySourceId: string;
  outcomeId: string;
  googleReceiptId: string;
  captureId: string;
  staff: { id: string; pin: string };
  /** `id -> plaintext` for rows with no production reader: opened with decryptSecret and the writer's AAD. */
  plain: { table: string; id: string; org: string | null; kind: string; text: string }[];
}

const bytes = (e: Envelope) => [e.kekVersion, e.iv, e.wrappedDek, e.ciphertext] as const;

/** Seeds every envelope place the Samsung fixture does not (all but provider credentials, ref, receipt). */
export async function seedEnvelopes(t: Samsung): Promise<Seeded> {
  const { kit } = t;
  const db = kit.env.DB;
  const ring = await loadKekRing(kit.env);
  const id = () => kit.ctx.ids.id();
  const now = kit.clock.now();
  const org = kit.org.id;
  const seal = (rowId: string, orgId: string | null, kind: string, text: string) =>
    encryptSecret(ring, text, credentialAad(rowId, orgId, kind));
  const plain: Seeded['plain'] = [];

  const credential = async (rowId: string, kind: string, text: string) => {
    const e = await seal(rowId, org, kind, text);
    await run(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rowId, org, kind, ...bytes(e), `fp-${rowId}`, now],
    );
  };
  const connectorId = id();
  const webhookCredentialId = id();
  const signerCredentialId = id();
  await credential(connectorId, 'connector', JSON.stringify({ apiKey: 'connector-secret' }));
  await credential(webhookCredentialId, 'webhook', 'webhook-secret');
  await credential(signerCredentialId, 'pass_signer', 'signer-pem');
  const signerCertSha = `sha-${signerCredentialId}`;
  await run(
    db,
    `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source,
       credential_id, cert_pem, cert_sha256, created_at)
     VALUES (?, ?, 'Rotation', ?, 'TEAMROT', 'db', ?, 'pem', ?, ?)`,
    [id(), org, `pass.rotation.${signerCredentialId}`, signerCredentialId, signerCertSha, now],
  );

  const team = `TEAM${id().slice(-6)}`;
  const apnsId = id();
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const apns = await encryptSecret(ring, der, credentialAad(apnsId, null, `apns_key:${team}`));
  await run(
    db,
    `INSERT INTO apns_keys (id, team_identifier, key_id, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, 'KEYID12345', ?, ?, ?, ?, ?)`,
    [apnsId, team, ...bytes(apns), now],
  );

  const personalized = await kit.pass();
  const personalization = await seal(
    personalized.id,
    org,
    'personalization',
    '{"memberName":"Sam"}',
  );
  await run(
    db,
    `INSERT INTO pass_personalizations (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, 'sha', ?, ?, ?, ?, ?)`,
    [personalized.id, ...bytes(personalization), now],
  );
  plain.push({
    table: 'pass_personalizations',
    id: personalized.id,
    org,
    kind: 'personalization',
    text: '{"memberName":"Sam"}',
  });

  const retentionId = id();
  const retention = await seal(retentionId, org, 'connection.webhook', '{"refs":[],"items":[]}');
  await run(
    db,
    `INSERT INTO connection_webhook_retention
     (id, connection_id, org_id, event_id, generation, source, connection_mode, reference_mode, ref_hash,
      state, release_snapshot, snapshot_known, item_count, chunk_count, kek_version, iv, wrapped_dek,
      ciphertext, received_at, updated_at, credential_keyset_commitment)
     VALUES (?, ?, ?, 'event', 1, 'ingress', 'webhook', 'refs-only', 'hash', 'pending', '{}', 0, 0, 1,
      ?, ?, ?, ?, ?, ?, ?)`,
    [retentionId, id(), org, ...bytes(retention), now, now, t.credentialKeysetCommitment],
  );
  plain.push({
    table: 'connection_webhook_retention',
    id: retentionId,
    org,
    kind: 'connection.webhook',
    text: '{"refs":[],"items":[]}',
  });
  const legacySourceId = id();
  const legacy = await seal(legacySourceId, org, 'connection.webhook.legacy-inbox', '{"rows":[]}');
  await run(
    db,
    `INSERT INTO connection_webhook_legacy_sources
     (id, connection_id, org_id, event_id, kek_version, iv, wrapped_dek, ciphertext, received_at)
     VALUES (?, ?, ?, 'event', ?, ?, ?, ?, ?)`,
    [legacySourceId, id(), org, ...bytes(legacy), now],
  );
  plain.push({
    table: 'connection_webhook_legacy_sources',
    id: legacySourceId,
    org,
    kind: 'connection.webhook.legacy-inbox',
    text: '{"rows":[]}',
  });

  const outcomeId = id();
  const outcome = await seal(outcomeId, org, 'wallet.provider.outcome', 'outcome-body');
  const operation = await first<{ id: string }>(
    db,
    'SELECT id FROM wallet_provider_instance_operations WHERE instance_id = ? LIMIT 1',
    [t.operation.instanceId],
  );
  await run(
    db,
    `INSERT INTO wallet_provider_instance_outcomes
     (id, operation_id, attempt, sequence, event_hash, payload_hash, kek_version, iv, wrapped_dek, ciphertext, received_at)
     VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [outcomeId, operation?.id, 'a'.repeat(64), 'b'.repeat(64), ...bytes(outcome), now],
  );
  plain.push({
    table: 'wallet_provider_instance_outcomes',
    id: outcomeId,
    org,
    kind: 'wallet.provider.outcome',
    text: 'outcome-body',
  });

  const googleReceiptId = id();
  const instance = await first<{ account_id: string; mode: string }>(
    db,
    'SELECT account_id, mode FROM wallet_provider_instances WHERE id = ?',
    [t.operation.instanceId],
  );
  const googleKind = `google-callback|${instance?.mode}|${t.operation.instanceId}`;
  const google = await seal(googleReceiptId, org, googleKind, 'google-body');
  await run(
    db,
    `INSERT INTO wallet_google_callback_receipts
     (id, instance_id, account_id, org_id, mode, event_type, nonce_hash, expires_at, received_at,
      kek_version, iv, wrapped_dek, ciphertext)
     VALUES (?, ?, ?, ?, ?, 'save', ?, ?, ?, ?, ?, ?, ?)`,
    [
      googleReceiptId,
      t.operation.instanceId,
      instance?.account_id,
      org,
      instance?.mode,
      'c'.repeat(64),
      now + 1000,
      now,
      ...bytes(google),
    ],
  );
  plain.push({
    table: 'wallet_google_callback_receipts',
    id: googleReceiptId,
    org,
    kind: googleKind,
    text: 'google-body',
  });

  const captureId = id();
  await run(
    db,
    `INSERT INTO captured_emails (id, org_id, pass_id, recipient, subject, html, text, created_at)
     VALUES (?, ?, ?, 'a@example.com', 's', ?, ?, ?)`,
    [
      captureId,
      org,
      personalized.id,
      await sealBody(kit.env, captureId, org, '<p>test link</p>'),
      await sealBody(kit.env, captureId, org, 'test link'),
      now,
    ],
  );
  const staff = await makeScanStaff(kit.fx, { orgId: org });
  return {
    connectorId,
    webhookCredentialId,
    signerCredentialId,
    signerCertSha,
    team,
    personalizedPassId: personalized.id,
    retentionId,
    legacySourceId,
    outcomeId,
    googleReceiptId,
    captureId,
    staff,
    plain,
  };
}

/** The count of rows still under KEK `version`, per table, as the retire tool counts them. */
export async function rowsOnKek(db: D1Database, version: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ENVELOPE_TABLES) {
    const row =
      table === CAPTURE_TABLE
        ? await first<{ n: number }>(
            db,
            'SELECT count(*) AS n FROM captured_emails WHERE html GLOB ? OR text GLOB ?',
            [`enc1:${version}.*`, `enc1:${version}.*`],
          )
        : await first<{ n: number }>(
            db,
            `SELECT count(*) AS n FROM ${table} WHERE kek_version = ?`,
            [version],
          );
    out[table] = row?.n ?? 0;
  }
  return out;
}

/**
 * A pending credential transfer with its sealed payload under `kek1` alone. It holds the pass's token MAC
 * sweep back (a transfer in flight is skipped), so a rotation seeds it after that sweep.
 */
export async function seedTransfer(t: Samsung, kek1: string): Promise<Seeded['plain'][number]> {
  const { kit } = t;
  const db = kit.env.DB;
  const ring = await loadKekRing({ KEK_V1: kek1 });
  const org = kit.org.id;
  const holder = await kit.pass();
  const transferId = kit.ctx.ids.id();
  await stagePendingCredentialTransfer(db, holder.id, {
    id: transferId,
    token: kit.ctx.ids.token(),
    now: kit.clock.now(),
  });
  const kind = 'pass-credential-transfer:live';
  const text = '{"personalization":{},"fieldSources":{}}';
  const payload = await encryptSecret(ring, text, credentialAad(transferId, org, kind));
  await withoutTrigger(db, 'pass_credential_transfer_payload_insert_guard', () =>
    run(
      db,
      `INSERT INTO pass_credential_transfer_payloads (transfer_id, kek_version, iv, wrapped_dek, ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
      [transferId, ...bytes(payload)],
    ),
  );
  return { table: 'pass_credential_transfer_payloads', id: transferId, org, kind, text };
}
