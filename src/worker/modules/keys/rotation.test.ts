import { describe, expect, it } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { EPOCH_TABLES } from '../../platform/authority-columns.ts';
import { revealToken, tokenMac } from '../../platform/capability-token.ts';
import {
  credentialAad,
  decryptSecretText,
  derivedHmacKey,
  keyedDigest,
  loadKekRing,
} from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { extractMacRoot } from '../../platform/mac-roots.ts';
import { bundleForToken } from '../bundles/public-service.ts';
import { createBundle } from '../bundles/service.ts';
import type { ConnectionRow } from '../connections/repo.ts';
import { readConnectorSecrets, readWebhookSecret } from '../connections/secrets.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { loadIdentityKey } from '../identities/db-resolver.ts';
import { clearPushKeyCache, loadPushKey } from '../identities/push-key-store.ts';
import type { IdentityRow } from '../identities/repo.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { credentialReferences } from '../passes/credential-references.ts';
import { remacCapabilityTokens } from '../passes/token-remac.ts';
import { passForToken } from '../public/service.ts';
import { openBody } from '../sandbox/captured-body.ts';
import { hashPin, pinMatches } from '../scan/staff-pin.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { checkKeys } from '../status/checks-keys.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { googleMessageAad } from '../wallet-providers/google-message-aad.ts';
import { openSecret, sealSecret } from '../webhooks/secrets.ts';
import { seedEndpoint } from '../webhooks/webhooks-test-fixtures.ts';
import { recordMacRoots } from './mac-root-check.ts';
import { packedEnvelopeColumns } from './packed-scan-test-fixtures.ts';
import { DONE, rewrapEnvelopes } from './rewrap.ts';
import { seedGoogleMessage } from './rotation-message-test-fixtures.ts';
import { rowsOnKek, type Samsung, seedEnvelopes, seedTransfer } from './rotation-test-fixtures.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const HOUR = 3_600_000;
type Env = Record<string, unknown>;

/** Every epoch column the platform keeps, and the signing identity and wallet authority counters. */
async function epochs(db: D1Database) {
  const out: Record<string, unknown> = {};
  for (const t of EPOCH_TABLES)
    out[t.table] = await all(
      db,
      `SELECT rowid AS r, ${Object.keys(t.epochs).join(', ')} FROM ${t.table} ORDER BY rowid`,
    );
  out.identities = await all(db, 'SELECT id, revision FROM signing_identities ORDER BY id');
  out.sequence = await all(db, 'SELECT revision FROM signing_identity_revision_sequence');
  out.walletAuthority = await all(
    db,
    'SELECT * FROM wallet_provider_pass_authority ORDER BY pass_id',
  );
  return out;
}

async function untilDone(t: Samsung, max = 60) {
  for (let i = 0; i < max; i++) {
    await rewrapEnvelopes(jobCtxOf(t.kit));
    if (await readSystemValue(t.kit.env.DB, DONE)) return;
  }
  throw new Error('the rewrap did not finish');
}

async function remacUntilDone(t: Samsung) {
  for (let i = 0; i < 12; i++) {
    await remacCapabilityTokens(jobCtxOf(t.kit));
    if ((await readSystemValue(t.kit.env.DB, 'tokens.remacDone')) !== null) return;
  }
  throw new Error('the MAC sweep did not finish');
}

async function rotate(macKeyRotation: boolean) {
  const db = await isolatedKeysetDatabase();
  const t = await setupSamsungCallbacks({ db });
  const { kit } = t;
  const env = kit.env as unknown as Env;
  const kek1 = env.KEK_V1 as string;
  const org = kit.org.id;
  const jobCtx = () => jobCtxOf(kit);
  const actor = { type: 'system', id: null } as const;

  // 1. Secrets and evidence under KEK_V1, through the real services where there is one.
  const seeded = await seedEnvelopes(t);
  // A join link's sealed token and an outbound webhook secret, through their writers.
  const joinLink = await makeJoinLink(kit.fx, { orgId: org, templateId: t.pass.templateId });
  const webhook = {
    secretId: kit.ctx.ids.id(),
    orgId: org,
    endpointId: await seedEndpoint(db, { orgId: org }),
    mode: 'live' as const,
  };
  const sealed = await sealSecret(await loadKekRing(kit.env), 'whsec_rotation', webhook);
  await run(
    db,
    `INSERT INTO webhook_endpoint_secrets (id, endpoint_id, org_id, mode, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, ?, 'live', ?, ?, ?, ?, 1)`,
    [
      webhook.secretId,
      webhook.endpointId,
      org,
      sealed.kekVersion,
      sealed.iv,
      sealed.wrappedDek,
      sealed.ciphertext,
    ],
  );
  const pass = t.pass;
  const bundle = await createBundle(
    jobCtx(),
    actor,
    'live',
    { orgId: org, passIds: [pass.id], name: 'Rotation' },
    { kind: 'system' },
  );
  const bundlePlain = bundle.url?.split('/b/')[1] ?? '';
  const stored = async () => ({
    link:
      (
        await first<{ download_token: string }>(
          db,
          'SELECT download_token FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.download_token ?? '',
    auth:
      (
        await first<{ auth_token: string }>(db, 'SELECT auth_token FROM passes WHERE id = ?', [
          pass.id,
        ])
      )?.auth_token ?? '',
    bundle:
      (await first<{ token: string }>(db, 'SELECT token FROM bundles WHERE id = ?', [bundle.id]))
        ?.token ?? '',
  });
  const before = await stored();
  const plainTokens = {
    link: await revealToken(kit.env, 'pass', pass.id, org, before.link),
    auth: await revealToken(kit.env, 'apple-auth', pass.id, org, before.auth),
    bundle: await revealToken(kit.env, 'bundle', bundle.id, org, before.bundle),
  };
  expect(await passForToken(jobCtx(), plainTokens.link)).toMatchObject({ id: pass.id });
  // A Samsung callback opens the provider credential and the ref, and writes a receipt.
  expect((await t.call({ token: await t.token() })).status).toBe(200);
  expect(
    (
      await t.call({
        method: 'POST',
        token: await t.token({ method: 'POST' }),
        query: '?cc2=gb&event=ADDED',
        body: '{"x":1}',
      })
    ).status,
  ).toBe(200);
  // Retired credentials: refs of a scan code, a barcode and a serial, kept as tombstones.
  const values = { scanCode: 'RETIRED-1', barcodeMessage: 'BARCODE-1', serial: 'SERIAL-1' };
  const refs = await credentialReferences(kit.env, org, 'live', values);
  await withoutTrigger(db, 'pass_credential_tombstones_insert_guard', async () => {
    for (const [i, r] of refs.entries())
      await run(
        db,
        `INSERT INTO pass_credential_tombstones (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
         VALUES (?, ?, 'live', ?, ?, ?, 1)`,
        [pass.id, org, i + 1, r.kind, r.ref],
      );
  });
  const labels = [
    'pass-credential-tombstone-v1',
    'scan-retention-proof.v1',
    'connection.webhook.item-ref.v1',
    'scan-action-reference.v1',
  ];
  const macOf = async (label: string) =>
    Buffer.from(
      await crypto.subtle.sign(
        'HMAC',
        await derivedHmacKey(kit.env, label),
        new TextEncoder().encode('m'),
      ),
    ).toString('hex');
  const evidenceBefore = await Promise.all(labels.map(macOf));
  const digestBefore = await keyedDigest(kit.env, 'counter.magic-ip.v1', '203.0.113.7');

  // 2. The KEK ring grows. Optionally the MAC root moves to V2 first (the compromise path).
  env.KEK_V2 = kek(2);
  if (macKeyRotation) {
    env.MAC_KEY_VERSION = '2';
    env.MAC_KEY_VERSION_PREVIOUS = '1';
    await remacUntilDone(t);
    await run(db, 'UPDATE scan_staff SET pin_hash = ?, pin_mac_version = 2 WHERE id = ?', [
      await hashPin(kit.env, seeded.staff.id, seeded.staff.pin),
      seeded.staff.id,
    ]);
    delete env.MAC_KEY_VERSION_PREVIOUS;
  }
  seeded.plain.push(await seedTransfer(t, kek1));
  seeded.plain.push(...(await seedGoogleMessage(t, kek1)));
  const epochsBefore = await epochs(db);

  // 3. The rewrap moves every envelope; nothing else changes.
  await untilDone(t);
  for (const [table, n] of Object.entries(await rowsOnKek(db, 1))) expect(n, table).toBe(0);
  // Every place held something, and all of it is on V2 now.
  for (const [table, n] of Object.entries(await rowsOnKek(db, 2)))
    expect(n, table).toBeGreaterThan(0);
  expect(await epochs(db)).toEqual(epochsBefore);

  // 4. The extracted root stands in for KEK_V1, which is then deleted.
  env.MAC_ROOT_V1 = await extractMacRoot(kek1);
  await recordMacRoots(jobCtx());
  expect(await readSystemValue(db, 'keys.macRoots')).toMatchObject({ '1': 'match' });
  // The cursors sealed under V1 are 24 hours gone.
  const done = (await readSystemValue(db, DONE)) as { startedAt: number };
  await writeSystemValue(
    db,
    DONE,
    { ...done, startedAt: kit.clock.now() - 25 * HOUR },
    kit.clock.now(),
  );
  expect(await checkKeys(jobCtx())).toMatchObject({ state: 'verified', data: { retirable: '1' } });
  delete env.KEK_V1;

  return {
    t,
    seeded,
    joinLink,
    webhook,
    bundle,
    plainTokens,
    stored,
    before,
    bundlePlain,
    refs,
    values,
    labels,
    macOf,
    evidenceBefore,
    digestBefore,
    epochsBefore,
    epochs: () => epochs(db),
    kek1,
    env,
    macKeyRotation,
    jobCtx,
  };
}

type Rotated = Awaited<ReturnType<typeof rotate>>;

async function expectEverythingOpens(r: Rotated) {
  const { t, seeded, env } = r;
  const { kit } = t;
  const db = kit.env.DB;
  const org = kit.org.id;
  const ring = await loadKekRing(kit.env);
  expect([...ring.keys.keys()]).toEqual([2]);

  // Real readers.
  expect(
    await readConnectorSecrets(r.jobCtx(), {
      orgId: org,
      credentialId: seeded.connectorId,
    } as ConnectionRow),
  ).toEqual({ apiKey: 'connector-secret' });
  expect(
    await readWebhookSecret(r.jobCtx(), {
      orgId: org,
      webhookCredentialId: seeded.webhookCredentialId,
    } as ConnectionRow),
  ).toBe('webhook-secret');
  expect(
    await loadIdentityKey(kit.env, {
      credential_id: seeded.signerCredentialId,
      cert_sha256: seeded.signerCertSha,
      org_id: org,
    } as IdentityRow),
  ).toBe('signer-pem');
  // A platform identity (org NULL) while the credential row carries an org.
  expect(
    await loadIdentityKey(kit.env, {
      credential_id: seeded.platformCredentialId,
      cert_sha256: `sha-${seeded.platformCredentialId}`,
      org_id: null,
    } as IdentityRow),
  ).toBe('platform-signer-pem');
  clearPushKeyCache();
  expect((await loadPushKey(kit.env, seeded.team))?.keyId).toBe('KEYID12345');
  const after = await r.stored();
  expect(await revealToken(kit.env, 'pass', t.pass.id, org, after.link)).toBe(r.plainTokens.link);
  expect(await revealToken(kit.env, 'apple-auth', t.pass.id, org, after.auth)).toBe(
    r.plainTokens.auth,
  );
  expect(await revealToken(kit.env, 'bundle', r.bundle.id, org, after.bundle)).toBe(
    r.plainTokens.bundle,
  );
  expect(await passForToken(r.jobCtx(), r.plainTokens.link)).toMatchObject({ id: t.pass.id });
  expect(await bundleForToken(r.jobCtx(), r.bundlePlain)).toMatchObject({ id: r.bundle.id });
  const joinMac = await first<{ token: string }>(db, 'SELECT token FROM join_links WHERE id = ?', [
    r.joinLink.id,
  ]);
  expect(await revealToken(kit.env, 'join', r.joinLink.id, org, joinMac?.token ?? '')).toBe(
    r.joinLink.token,
  );
  const secret = await first<{
    iv: ArrayBuffer;
    wrapped_dek: ArrayBuffer;
    ciphertext: ArrayBuffer;
  }>(db, 'SELECT iv, wrapped_dek, ciphertext FROM webhook_endpoint_secrets WHERE id = ?', [
    r.webhook.secretId,
  ]);
  expect(
    await openSecret(
      ring,
      {
        kekVersion: 2,
        iv: new Uint8Array(secret?.iv ?? []),
        wrappedDek: new Uint8Array(secret?.wrapped_dek ?? []),
        ciphertext: new Uint8Array(secret?.ciphertext ?? []),
      },
      r.webhook,
    ),
  ).toBe('whsec_rotation');
  for (const row of await all<{ id: string; html: string; text: string }>(
    db,
    'SELECT id, html, text FROM captured_emails WHERE id = ?',
    [seeded.captureId],
  )) {
    expect(await openBody(kit.env, row.id, org, row.html)).toBe('<p>test link</p>');
    expect(await openBody(kit.env, row.id, org, row.text)).toBe('test link');
  }
  // Provider credential, Samsung ref and a new receipt, through the callback route.
  expect((await t.call({ token: await t.token() })).status).toBe(200);
  expect(
    (
      await t.call({
        method: 'POST',
        token: await t.token({ method: 'POST' }),
        query: '?cc2=us&event=ADDED',
        body: '{"y":2}',
      })
    ).status,
  ).toBe(200);
  // Rows with no production reader open with the writer's AAD. The account table keeps its envelope in hmac_*.
  const hmacColumns = (table: string) =>
    table === 'wallet_provider_accounts'
      ? 'hmac_kek_version AS kek_version, hmac_iv AS iv, hmac_wrapped_dek AS wrapped_dek, hmac_ciphertext AS ciphertext'
      : 'kek_version, iv, wrapped_dek, ciphertext';
  for (const p of seeded.plain) {
    const row = await first<{
      kek_version: number;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      ciphertext: ArrayBuffer;
    }>(
      db,
      `SELECT ${hmacColumns(p.table)} FROM ${p.table} WHERE ${p.table === 'pass_personalizations' ? 'pass_id' : p.table === 'pass_credential_transfer_payloads' ? 'transfer_id' : p.table === 'nfc_tag_sun' || p.table === 'nfc_tag_admin_keys' ? 'tag_id' : 'id'} = ?`,
      [p.id],
    );
    expect(row?.kek_version, p.table).toBe(2);
    expect(
      await decryptSecretText(
        ring,
        {
          kekVersion: 2,
          iv: new Uint8Array(row?.iv ?? []),
          wrappedDek: new Uint8Array(row?.wrapped_dek ?? []),
          ciphertext: new Uint8Array(row?.ciphertext ?? []),
        },
        p.table === 'wallet_google_messages'
          ? googleMessageAad(p.kind, p.id)
          : credentialAad(p.id, p.org, p.kind),
      ),
      p.table,
    ).toBe(p.text);
  }

  // Evidence is unchanged: retired credentials are still recognized.
  expect(await requireCredentialRefKeyset(db, kit.env)).toMatch(/^[0-9a-f]{64}$/);
  expect(await credentialReferences(kit.env, org, 'live', r.values)).toEqual(r.refs);
  for (const ref of r.refs)
    expect(
      await first(
        db,
        'SELECT 1 AS x FROM pass_credential_tombstones WHERE org_id = ? AND mode = ? AND credential_hash = ?',
        [org, 'live', ref.ref],
      ),
    ).not.toBeNull();
  expect(await Promise.all(r.labels.map(r.macOf))).toEqual(r.evidenceBefore);
  expect(await keyedDigest(kit.env, 'counter.magic-ip.v1', '203.0.113.7')).toBe(r.digestBefore);
  const staff = await first<{ pin_hash: string }>(
    db,
    'SELECT pin_hash FROM scan_staff WHERE id = ?',
    [seeded.staff.id],
  );
  expect(await pinMatches(kit.env, seeded.staff.id, seeded.staff.pin, staff?.pin_hash ?? '')).toBe(
    true,
  );
  expect(await pinMatches(kit.env, seeded.staff.id, '000000', staff?.pin_hash ?? '')).toBe(false);
  // Retired credentials stay refused, and no authority epoch moved.
  expect(await r.epochs()).toEqual({ ...r.epochsBefore, walletAuthority: expect.anything() });
  expect(await checkKeys(r.jobCtx())).toMatchObject({ state: 'verified' });
  // Nothing else in the database holds a packed envelope that the rewrap does not see.
  expect(await packedEnvelopeColumns(db)).toEqual([]);
  // The ring has no KEK_V1 any more.
  expect(env.KEK_V1).toBeUndefined();
  expect(await tokenMac(kit.env, 'pass', r.plainTokens.link)).toBe(after.link);
}

describe('KEK rotation: V1 to V2, then V1 removed', () => {
  it('opens every secret through its reader and keeps every retired credential retired', async () => {
    await expectEverythingOpens(await rotate(false));
  }, 120_000);

  it('does the same after the MAC key rotation of the compromise path', async () => {
    const r = await rotate(true);
    await expectEverythingOpens(r);
    // The tokens now sit under root 2 and the PIN under root 2.
    expect(
      await first(r.t.kit.env.DB, 'SELECT pin_mac_version FROM scan_staff WHERE id = ?', [
        r.seeded.staff.id,
      ]),
    ).toEqual({ pin_mac_version: 2 });
  }, 120_000);

  it('fails closed without the extracted root, and flags a wrong one while the KEK still works', async () => {
    const r = await rotate(false);
    const { kit } = r.t;
    const env = kit.env as unknown as Env;
    delete env.MAC_ROOT_V1;
    await expect(requireCredentialRefKeyset(kit.env.DB, kit.env)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    await expect(requireCredentialRefKeyset(kit.env.DB, kit.env)).rejects.toBeInstanceOf(
      UnavailableError,
    );
    const missing = await checkKeys(r.jobCtx());
    expect(missing.state).toBe('failing');
    expect(missing.detail).toContain('Root 1 is missing');
    // A wrong root with KEK_V1 present: Status fails, the KEK wins, nothing breaks.
    env.KEK_V1 = r.kek1;
    env.MAC_ROOT_V1 = await extractMacRoot(kek(9));
    expect((await checkKeys(r.jobCtx())).detail).toContain('MAC_ROOT_V1 does not match KEK_V1');
    expect(await requireCredentialRefKeyset(kit.env.DB, kit.env)).toMatch(/^[0-9a-f]{64}$/);
    expect(await Promise.all(r.labels.map(r.macOf))).toEqual(r.evidenceBefore);
  }, 120_000);
});
