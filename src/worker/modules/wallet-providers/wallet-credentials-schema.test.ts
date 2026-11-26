// 0112: one case per trigger rule of design-wallet-accounts.md section 2. Each case breaks one rule and
// keeps every other valid, so the message names the trigger that fired. Storage lasts for the whole file and
// the rows are never deleted: every case seeds its own org, and a platform credential replaces the last.
import { describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, first, run, stmt } from '../../platform/db.ts';
import {
  addCheck,
  credential,
  credentialRevision,
  db,
  granted,
  ident,
  insertCredential,
  insertCredentialEvent,
  insertVersion,
  refused,
  revokeCredential,
  rotate,
  seedOrg,
  uid,
  verify,
} from './repo-wallet-credentials-test-fixtures.ts';
import {
  disable,
  enable,
  enrolment,
  grantFor,
  hold,
  insertEnrolmentEvent,
  receiptSeeder,
  release,
  revokeEnrolment,
  setSource,
  updateEnrolment,
} from './repo-wallet-enrolments-test-fixtures.ts';

const INSERT_CREDENTIAL = `INSERT INTO wallet_credentials (id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at, updated_at`;

describe('credentials', () => {
  it('scope and org agree: a platform row has no org, an org row has one', async () => {
    const { org } = await seedOrg();
    const values = `'live', 'google', ?, 'abcd', 1, 1)`;
    await refused(
      run(db(), `${INSERT_CREDENTIAL}) VALUES (?, 'platform', ?, ${values}`, [
        uid(),
        org.id,
        ident(),
      ]),
      /CHECK constraint failed/,
    );
    await refused(
      run(db(), `${INSERT_CREDENTIAL}) VALUES (?, 'org', NULL, ${values}`, [uid(), ident()]),
      /CHECK constraint failed/,
    );
    await insertCredential({ orgId: org.id });
  });

  it('starts empty: a version, revision, verified or revoked value at insert is refused', async () => {
    const { org } = await seedOrg();
    const other = await credential({ orgId: org.id, mode: 'test' });
    for (const [column, value] of [
      ['revision', 1],
      ['verified_at', 5],
      ['revoked_at', 5],
      ['current_version_id', other.versionId],
    ] as const)
      await refused(
        run(
          db(),
          `${INSERT_CREDENTIAL}, ${column}) VALUES (?, 'org', ?, 'live', 'google', ?, 'abcd', 1, 1, ?)`,
          [uid(), org.id, ident(), value],
        ),
        /starts empty|CHECK constraint failed/,
      );
  });

  it('keeps one active credential per scope, org, mode and provider; a revoked one frees the slot', async () => {
    const { org } = await seedOrg();
    await credential({ scope: 'platform' });
    await refused(insertCredential({ scope: 'platform' }), /UNIQUE constraint failed/);
    const mine = await credential({ orgId: org.id });
    await refused(insertCredential({ orgId: org.id }), /UNIQUE constraint failed/);
    await insertCredential({ orgId: org.id, mode: 'test' });
    await revokeCredential(mine.id);
    await insertCredential({ orgId: org.id });
  });

  it('refuses an org credential that takes an active platform identity', async () => {
    const { org } = await seedOrg();
    const shared = ident();
    const platform = await credential({ scope: 'platform', identity: shared });
    await refused(insertCredential({ orgId: org.id, identity: shared }), /belongs to the platform/);
    // Another mode or provider is another identity.
    await insertCredential({ orgId: org.id, mode: 'test', identity: shared });
    await insertCredential({ orgId: org.id, provider: 'samsung', identity: shared });
    await revokeCredential(platform.id, 'platform');
    await insertCredential({ orgId: org.id, identity: shared });
  });

  it('indexes platform and verified org identities only: an unverified squat does not block the platform', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const shared = ident();
    const one = await credential({ orgId: a.org.id, identity: shared });
    const two = await credential({ orgId: b.org.id, identity: shared });
    await verify(one);
    await refused(verify(two), /UNIQUE constraint failed/);
    const squatted = ident();
    const squat = await credential({ orgId: a.org.id, mode: 'test', identity: squatted });
    await credential({ scope: 'platform', mode: 'test', identity: squatted });
    await refused(verify(squat), /UNIQUE constraint failed/);
  });

  it('a version carries its credential identity, and a revoked credential takes none', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    await refused(insertVersion(c.id, ident()), /keep the credential identity/);
    await insertVersion(c.id, c.identity);
    await revokeCredential(c.id);
    await refused(insertVersion(c.id, c.identity), /keep the credential identity/);
  });

  it('sets the first version only with a create event at revision + 1', async () => {
    const { org } = await seedOrg();
    const set = (id: string, version: string, revision = 1) =>
      run(db(), 'UPDATE wallet_credentials SET revision = ?, current_version_id = ? WHERE id = ?', [
        revision,
        version,
        id,
      ]);
    const bare = await insertCredential({ orgId: org.id });
    const v1 = await insertVersion(bare.id, bare.identity);
    await refused(set(bare.id, v1), /invalid wallet credential transition/);
    await insertCredentialEvent({
      credentialId: bare.id,
      revision: 1,
      kind: 'rotate',
      versionId: v1,
    });
    await refused(set(bare.id, v1), /invalid wallet credential transition/);
    const skipped = await insertCredential({ orgId: org.id, mode: 'test' });
    const v2 = await insertVersion(skipped.id, skipped.identity);
    await insertCredentialEvent({
      credentialId: skipped.id,
      revision: 2,
      kind: 'create',
      versionId: v2,
    });
    await refused(set(skipped.id, v2, 2), /invalid wallet credential transition/);
    const ok = await insertCredential({ orgId: org.id, provider: 'samsung' });
    const v3 = await insertVersion(ok.id, ok.identity);
    await insertCredentialEvent({
      credentialId: ok.id,
      revision: 1,
      kind: 'create',
      versionId: v3,
    });
    await set(ok.id, v3);
  });

  it("cannot point at another credential's version, another org's included", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const mine = await credential({ orgId: a.org.id });
    const theirs = await credential({ orgId: b.org.id });
    const fresh = await insertCredential({ orgId: a.org.id, mode: 'test' });
    // The event cannot name the foreign version (its own composite key), so the first set has no event to match.
    await refused(
      insertCredentialEvent({
        credentialId: fresh.id,
        revision: 1,
        kind: 'create',
        versionId: theirs.versionId,
      }),
      /FOREIGN KEY/,
    );
    await refused(
      run(db(), 'UPDATE wallet_credentials SET revision = 1, current_version_id = ? WHERE id = ?', [
        theirs.versionId,
        fresh.id,
      ]),
      /FOREIGN KEY|invalid wallet credential transition/,
    );
    await refused(
      run(db(), 'UPDATE wallet_credentials SET revision = 2, current_version_id = ? WHERE id = ?', [
        theirs.versionId,
        mine.id,
      ]),
      /FOREIGN KEY|invalid wallet credential transition/,
    );
  });

  it('rotates with a rotate event; the card map keeps every key and value and may grow', async () => {
    const { org } = await seedOrg();
    const c = await credential({
      orgId: org.id,
      provider: 'samsung',
      cardMap: '{"gift":"h1","pass":"h2"}',
    });
    await refused(rotate(c, '{"gift":"h1"}'), /card map is append-only/);
    await refused(rotate(c, '{"gift":"hX","pass":"h2"}'), /card map is append-only/);
    expect(await credentialRevision(c.id)).toBe(1);
    const next = await rotate(c, '{"gift":"h1","pass":"h2","tier":"h3"}');
    const row = await first<{ v: string; r: number }>(
      db(),
      'SELECT current_version_id AS v, revision AS r FROM wallet_credentials WHERE id = ?',
      [c.id],
    );
    expect(row).toEqual({ v: next, r: 2 });
  });

  it('a rotation needs a rotate event, not a create or a missing one', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    const v = await insertVersion(c.id, c.identity);
    const set = () =>
      run(db(), 'UPDATE wallet_credentials SET revision = 2, current_version_id = ? WHERE id = ?', [
        v,
        c.id,
      ]);
    await refused(set(), /invalid wallet credential transition/);
    await insertCredentialEvent({ credentialId: c.id, revision: 2, kind: 'create', versionId: v });
    await refused(set(), /invalid wallet credential transition/);
  });

  it('identity, scope, org, mode and provider are immutable, and a credential is never deleted', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    for (const set of [
      `identity_hash = '${ident()}'`,
      "mode = 'test'",
      "provider = 'samsung'",
      "scope = 'platform'",
      'org_id = NULL',
      "identity_hint = 'zzzz'",
      'created_at = 5',
    ])
      await refused(
        run(db(), `UPDATE wallet_credentials SET ${set} WHERE id = ?`, [c.id]),
        /immutable|CHECK constraint failed/,
      );
    await refused(
      run(db(), 'DELETE FROM wallet_credentials WHERE id = ?', [c.id]),
      /immutable wallet credential/,
    );
  });

  it('verify needs a successful check of the current version', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    await refused(verify(c, false), /invalid wallet credential transition/);
    await addCheck(c.id, c.versionId, 0);
    await refused(verify(c, false), /invalid wallet credential transition/);
    const rotated = await rotate(c);
    // The ok check below is of the first version; the current one is the rotation.
    await addCheck(c.id, c.versionId);
    await refused(verify(c, false), /invalid wallet credential transition/);
    await addCheck(c.id, rotated);
    await verify(c, false);
  });

  it('a revoke needs its revoke event and moves revoked_at once', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    await refused(
      run(db(), 'UPDATE wallet_credentials SET revision = 2, revoked_at = 9 WHERE id = ?', [c.id]),
      /invalid wallet credential transition/,
    );
    await refused(
      run(db(), 'UPDATE wallet_credentials SET revoked_at = 9 WHERE id = ?', [c.id]),
      /invalid wallet credential transition/,
    );
    await revokeCredential(c.id);
    await refused(revokeCredential(c.id), /invalid wallet credential transition/);
  });

  it('versions are rewrap-only; versions, events and checks cannot be deleted or edited', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    const checkId = await addCheck(c.id, c.versionId);
    await run(
      db(),
      'UPDATE wallet_credential_versions SET kek_version = 2, wrapped_dek = ? WHERE id = ?',
      [new Uint8Array(60).fill(9), c.versionId],
    );
    await refused(
      run(db(), 'UPDATE wallet_credential_versions SET ciphertext = ? WHERE id = ?', [
        new Uint8Array(40).fill(9),
        c.versionId,
      ]),
      /immutable wallet credential version/,
    );
    await refused(
      run(db(), `UPDATE wallet_credential_versions SET card_map = '{"a":"b"}' WHERE id = ?`, [
        c.versionId,
      ]),
      /immutable wallet credential version/,
    );
    await refused(
      run(db(), 'DELETE FROM wallet_credential_versions WHERE id = ?', [c.versionId]),
      /immutable wallet credential version/,
    );
    await refused(
      run(db(), "UPDATE wallet_credential_events SET kind = 'revoke' WHERE credential_id = ?", [
        c.id,
      ]),
      /immutable wallet credential event/,
    );
    await refused(
      run(db(), 'DELETE FROM wallet_credential_events WHERE credential_id = ?', [c.id]),
      /immutable wallet credential event/,
    );
    await refused(
      run(db(), 'UPDATE wallet_credential_checks SET ok = 0 WHERE id = ?', [checkId]),
      /immutable wallet credential check/,
    );
    await refused(
      run(db(), 'DELETE FROM wallet_credential_checks WHERE id = ?', [checkId]),
      /immutable wallet credential check/,
    );
  });
});

describe('credential checks and the server clock', () => {
  it('stamps a check from the server clock and refuses an explicit stamp more than 5 s away', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    const id = await addCheck(c.id, c.versionId);
    const row = await first<{ t: number }>(
      db(),
      'SELECT checked_at AS t FROM wallet_credential_checks WHERE id = ?',
      [id],
    );
    expect(Math.abs((row?.t ?? 0) - Date.now())).toBeLessThan(5000);
    await refused(addCheck(c.id, c.versionId, 1, Date.now() - 60_000), /needs the server clock/);
    await refused(addCheck(c.id, c.versionId, 1, Date.now() + 60_000), /needs the server clock/);
    await addCheck(c.id, c.versionId, 1, Date.now() - 1000);
  });

  it('a check names a version of its own credential', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const mine = await credential({ orgId: a.org.id });
    const theirs = await credential({ orgId: b.org.id });
    await refused(addCheck(mine.id, theirs.versionId), /FOREIGN KEY/);
  });

  it('credential and enrolment events are stamped by the server clock too', async () => {
    const { org } = await seedOrg();
    const c = await insertCredential({ orgId: org.id });
    const v = await insertVersion(c.id, c.identity);
    await refused(
      insertCredentialEvent({
        credentialId: c.id,
        revision: 1,
        kind: 'create',
        versionId: v,
        createdAt: Date.now() - 60_000,
      }),
      /needs the server clock/,
    );
    const a = await enrolment(org.id);
    await refused(
      insertEnrolmentEvent(a, { kind: 'disable', createdAt: Date.now() + 60_000 }),
      /needs the server clock/,
    );
  });
});

describe('enrolment source', () => {
  it('starts without a source, identity, enable or hold', async () => {
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    for (const [column, value] of [
      ['credential_source_id', c.id],
      ['identity_hash', ident()],
      ['enabled_at', 5],
      ['enrolment_revision', 1],
      ['platform_hold_at', 5],
      ['platform_hold_reason', 'x'],
    ] as const)
      await refused(
        run(
          db(),
          `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at, ${column}) VALUES (?, ?, 'live', 'google', 1, 1, ?)`,
          [uid(), org.id, value],
        ),
        /starts without a source/,
      );
  });

  it('needs a source event at the next revision naming the source', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    const c = await credential({ orgId: org.id });
    const other = await credential({ orgId: org.id, mode: 'test' });
    const set = { credential_source_id: c.id, identity_hash: c.identity, enabled_at: null };
    await refused(updateEnrolment(a, set), /needs its event/);
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: other.id });
    await refused(updateEnrolment(a, set), /needs its event/);
    await refused(updateEnrolment(a, set, 3), /needs its event/);
  });

  it("refuses another org's credential and accepts the platform's and its own", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const theirs = await credential({ orgId: b.org.id });
    const platform = await credential({ scope: 'platform' });
    const mine = await credential({ orgId: a.org.id, mode: 'test' });
    const live = await enrolment(a.org.id);
    // The event trigger refuses this first (wallet-credentials-review.test.ts); the account's own guard is proven with it off.
    await withoutTrigger(db(), 'wallet_enrolment_events_credential', () =>
      refused(setSource(live, theirs), /source is unavailable/),
    );
    await setSource(live, platform);
    await setSource(await enrolment(a.org.id, 'test'), mine);
  });

  it('refuses a source of another mode or provider, a revoked one, and an identity that differs', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    const wrongMode = await credential({ orgId: org.id, mode: 'test' });
    const wrongProvider = await credential({ orgId: org.id, provider: 'samsung' });
    await refused(setSource(a, wrongMode), /source is unavailable/);
    await refused(setSource(a, wrongProvider), /source is unavailable/);
    // A source event written while the credential was active, then the credential is revoked: the update is refused.
    const gone = await credential({ scope: 'platform' });
    const x = await enrolment((await seedOrg()).org.id);
    await insertEnrolmentEvent(x, { kind: 'source', credentialId: gone.id });
    await revokeCredential(gone.id, 'platform');
    await refused(
      updateEnrolment(x, {
        credential_source_id: gone.id,
        identity_hash: gone.identity,
        enabled_at: null,
      }),
      /source is unavailable/,
    );
    const good = await credential({ scope: 'platform' });
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: good.id });
    await refused(
      updateEnrolment(a, {
        credential_source_id: good.id,
        identity_hash: ident(),
        enabled_at: null,
      }),
      /source is unavailable/,
    );
    await refused(
      updateEnrolment(a, { credential_source_id: good.id, identity_hash: null, enabled_at: null }),
      /source is unavailable/,
    );
    await updateEnrolment(a, {
      credential_source_id: good.id,
      identity_hash: good.identity,
      enabled_at: null,
    });
  });

  it('a credential with no version is no source', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    const bare = await insertCredential({ orgId: org.id });
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: bare.id });
    await refused(
      updateEnrolment(a, {
        credential_source_id: bare.id,
        identity_hash: bare.identity,
        enabled_at: null,
      }),
      /source is unavailable/,
    );
  });

  it('a switch while On is refused; the same UPDATE turning it Off is accepted', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const one = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, one);
    await enable(a, one);
    const two = await credential({ orgId: org.id, mode: 'test' });
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: two.id });
    const set = { credential_source_id: two.id, identity_hash: two.identity };
    await refused(updateEnrolment(a, set), /switch turns it off/);
    await updateEnrolment(a, { ...set, enabled_at: null });
    expect(
      (
        await first<{ e: number | null }>(
          db(),
          'SELECT enabled_at AS e FROM wallet_provider_accounts WHERE id = ?',
          [a.id],
        )
      )?.e,
    ).toBeNull();
  });

  it('an identity changes only with its source', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: c.id });
    await refused(updateEnrolment(a, { identity_hash: ident() }), /identity follows its source/);
  });
});

describe('enable', () => {
  async function ready(mode: 'live' | 'test' = 'test') {
    const { f, org } = await seedOrg();
    const a = await enrolment(org.id, mode);
    const c = await credential({ scope: 'platform', mode });
    await setSource(a, c);
    return { f, org, a, c };
  }

  it('needs its enable event, which names the source and a check', async () => {
    const { a, c } = await ready();
    const at = Date.now();
    await refused(updateEnrolment(a, { enabled_at: at }), /needs its event|fresh credential check/);
    const checkId = await addCheck(c.id, c.versionId);
    await insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId, createdAt: at });
    await refused(updateEnrolment(a, { enabled_at: at + 1 }), /needs its event/);
    await updateEnrolment(a, { enabled_at: at });
  });

  it('refuses a failed or absent check, and a stamp the app chose', async () => {
    const { a, c } = await ready();
    await refused(
      addCheck(c.id, c.versionId, 1, Date.now() - 86_400_000 - 10_000),
      /needs the server clock/,
    );
    await refused(
      run(db(), 'UPDATE wallet_credential_checks SET checked_at = 1'),
      /immutable wallet credential check/,
    );
    await refused(
      enable(a, c, { checkId: await addCheck(c.id, c.versionId, 0) }),
      /fresh credential check/,
    );
    await refused(
      granted(grantFor(a, 'enable') ?? { purpose: '', principal: '' }, [
        stmt(
          db(),
          `INSERT INTO wallet_enrolment_events (id, account_id, org_id, mode, provider, enrolment_revision, kind, credential_id, actor_type, actor_id)
        SELECT ?, id, org_id, mode, provider, enrolment_revision + 1, 'enable', credential_source_id, 'user', 'u' FROM wallet_provider_accounts WHERE id = ?`,
          [uid(), a.id],
        ),
      ]),
      /CHECK constraint failed/,
    );
    await enable(a, c);
  });

  it('refuses a check of another credential, or of a version that is no longer current', async () => {
    const { org, a, c } = await ready();
    const other = await credential({ orgId: org.id, mode: 'test' });
    await refused(
      enable(a, c, { checkId: await addCheck(other.id, other.versionId) }),
      /fresh credential check/,
    );
    const old = await addCheck(c.id, c.versionId);
    await rotate(c);
    await refused(enable(a, c, { checkId: old }), /fresh credential check/);
    await enable(a, c);
  });

  it('refuses an enable event that names another credential than the source', async () => {
    const { org, a, c } = await ready();
    const other = await credential({ orgId: org.id, mode: 'test' });
    await refused(
      enable(a, c, { credentialId: other.id, checkId: await addCheck(c.id, c.versionId) }),
      /fresh credential check/,
    );
  });

  it('an org source needs verified_at; a platform source does not', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const mine = await credential({ orgId: org.id, mode: 'test' });
    await setSource(a, mine);
    await refused(enable(a, mine), /needs a verified source/);
    await verify(mine);
    await enable(a, mine);
    const { a: b } = await ready();
    expect(b.id).not.toBe(a.id);
  });

  it('a revoked source cannot be enabled, nor can an enrolment with no source', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ orgId: org.id, mode: 'test' });
    await verify(c);
    await refused(enable(a, c), /needs an active source|fresh credential check/);
    await setSource(a, c);
    // The enable event is written while the source is active; the source is revoked before the update.
    const at = Date.now();
    const checkId = await addCheck(c.id, c.versionId);
    await insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId, createdAt: at });
    await revokeCredential(c.id);
    await refused(updateEnrolment(a, { enabled_at: at }), /needs an active source/);
  });

  it('a Live enable needs a Test round trip received after the Test source event', async () => {
    const { f, org } = await seedOrg();
    const seed = receiptSeeder(f, org.id);
    const live = await enrolment(org.id, 'live');
    const test = await enrolment(org.id, 'test');
    const liveCred = await credential({ scope: 'platform' });
    const testCred = await credential({ scope: 'platform', mode: 'test' });
    await setSource(live, liveCred);
    await refused(enable(live, liveCred), /needs a Test round trip/);
    // The Test enrolment has no source yet, so its receipt predates one.
    const early = await seed.google(test, Date.now() - 10);
    await setSource(test, testCred);
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'google_save', id: early } }),
      /needs a Test round trip/,
    );
    const deleted = await seed.google(test, Date.now() + 10, 'del');
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'google_save', id: deleted } }),
      /needs a Test round trip/,
    );
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'google_save', id: uid() } }),
      /needs a Test round trip/,
    );
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'samsung_added', id: deleted } }),
      /needs a Test round trip/,
    );
    const saved = await seed.google(test, Date.now() + 20);
    await enable(live, liveCred, { roundTrip: { kind: 'google_save', id: saved } });
  });

  it("a Samsung Live enable needs an ADDED receipt on the org's own Test enrolment", async () => {
    const mine = await seedOrg();
    const theirs = await seedOrg();
    const live = await enrolment(mine.org.id, 'live', 'samsung');
    const test = await enrolment(mine.org.id, 'test', 'samsung');
    const foreign = await enrolment(theirs.org.id, 'test', 'samsung');
    const liveCred = await credential({ scope: 'platform', provider: 'samsung' });
    await setSource(live, liveCred);
    await setSource(
      test,
      await credential({ scope: 'platform', provider: 'samsung', mode: 'test' }),
    );
    await setSource(
      foreign,
      await credential({ orgId: theirs.org.id, provider: 'samsung', mode: 'test' }),
    );
    const ours = receiptSeeder(mine.f, mine.org.id);
    const stolen = await receiptSeeder(theirs.f, theirs.org.id).samsung(foreign, Date.now() + 10);
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'samsung_added', id: stolen } }),
      /needs a Test round trip/,
    );
    const removed = await ours.samsung(test, Date.now() + 10, 'DELETED');
    await refused(
      enable(live, liveCred, { roundTrip: { kind: 'samsung_added', id: removed } }),
      /needs a Test round trip/,
    );
    const added = await ours.samsung(test, Date.now() + 20, 'ADDED');
    await enable(live, liveCred, { roundTrip: { kind: 'samsung_added', id: added } });
  });
});

describe('platform hold', () => {
  it('a hold event turns the enrolment Off and refuses enable until a release event', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await enable(a, c);
    const at = Date.now();
    const held = { enabled_at: null, platform_hold_at: at, platform_hold_reason: 'abuse' };
    await refused(updateEnrolment(a, held), /needs its event/);
    await insertEnrolmentEvent(a, { kind: 'hold', reason: 'abuse', createdAt: at });
    await updateEnrolment(a, held);
    await refused(enable(a, c), /held by the platform/);
    await insertEnrolmentEvent(a, { kind: 'release' });
    await refused(
      updateEnrolment(a, { platform_hold_at: null, platform_hold_reason: 'abuse' }),
      /needs its event/,
    );
    await updateEnrolment(a, { platform_hold_at: null, platform_hold_reason: null });
    await enable(a, c);
  });

  it('a hold turns an On enrolment Off and records its reason; a release leaves it Off until enabled again', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await enable(a, c);
    await hold(a, 'abuse');
    const columns = 'enabled_at AS e, platform_hold_reason AS why, enrolment_revision AS r';
    const row = () =>
      first(db(), `SELECT ${columns} FROM wallet_provider_accounts WHERE id = ?`, [a.id]);
    expect(await row()).toEqual({ e: null, why: 'abuse', r: 3 });
    await refused(enable(a, c), /held by the platform/);
    await release(a);
    expect(await row()).toEqual({ e: null, why: null, r: 4 });
    await enable(a, c);
  });

  it('a hold or release is a platform actor, and a hold has a reason', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    await refused(
      insertEnrolmentEvent(a, { kind: 'hold', reason: 'x', actorType: 'user' }),
      /CHECK constraint failed/,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'release', actorType: 'system' }),
      /CHECK constraint failed/,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'hold', reason: null }),
      /CHECK constraint failed/,
    );
  });

  it('a hold cannot be repeated and a release needs a hold', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    await insertEnrolmentEvent(a, { kind: 'release' });
    await refused(
      updateEnrolment(a, { platform_hold_at: null, platform_hold_reason: null }),
      /needs its event/,
    );
    const at = Date.now();
    await insertEnrolmentEvent(a, { kind: 'hold', reason: 'r', createdAt: at, revision: 2 });
    await refused(
      updateEnrolment(a, { enabled_at: null, platform_hold_at: at, platform_hold_reason: 'r' }),
      /needs its event/,
    );
  });
});

describe('the enrolment step', () => {
  it('moves one revision per event, and the event kind must match the change', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    const checkId = await addCheck(c.id, c.versionId);
    const at = Date.now();
    await insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId, createdAt: at });
    const refusedStep = /needs its event|fresh credential check/;
    await refused(updateEnrolment(a, { enabled_at: at }, 5), refusedStep);
    await refused(updateEnrolment(a, { enabled_at: at + 1 }), refusedStep);
    await refused(
      updateEnrolment(a, { platform_hold_at: at, platform_hold_reason: 'x' }),
      /needs its event/,
    );
    await updateEnrolment(a, { enabled_at: at });
    await insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId });
    await refused(updateEnrolment(a, { enabled_at: null }), /needs its event/);
  });

  it('enabled_at leaves revision and the account audit alone; each step is audited once, without ids', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await enable(a, c);
    await disable(a);
    const row = await first<{ revision: number; enrolment_revision: number }>(
      db(),
      'SELECT revision, enrolment_revision FROM wallet_provider_accounts WHERE id = ?',
      [a.id],
    );
    expect(row).toEqual({ revision: 0, enrolment_revision: 3 });
    const accountAudit = await all(
      db(),
      "SELECT 1 FROM audit_log WHERE action LIKE 'wallet_provider.account_%' AND target_id = ?",
      [a.id],
    );
    expect(accountAudit).toEqual([]);
    const audit = await all<{ action: string; detail: string }>(
      db(),
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'wallet_provider.enrolment_%' ORDER BY id",
      [a.id],
    );
    expect(audit.map((r) => r.action)).toEqual([
      'wallet_provider.enrolment_source',
      'wallet_provider.enrolment_enable',
      'wallet_provider.enrolment_disable',
    ]);
    for (const r of audit) expect(r.detail).not.toContain(c.identity);
  });

  it('a rotation does not dirty instances; the dirty trigger follows enabled_at and the source only', async () => {
    const trigger = await first<{ sql: string }>(
      db(),
      "SELECT sql FROM sqlite_master WHERE name = 'wallet_provider_dirty_enrolment'",
    );
    expect(trigger?.sql).toMatch(
      /AFTER UPDATE OF enabled_at, credential_source_id ON wallet_provider_accounts/,
    );
    const { org } = await seedOrg();
    const c = await credential({ orgId: org.id });
    await rotate(c);
    const none = await all(db(), 'SELECT 1 FROM wallet_provider_instance_dirty');
    expect(none).toEqual([]);
  });
});

describe('revoking a new-model enrolment', () => {
  it('revokes an Off enrolment with no legacy credential, with its event, and enable is refused after', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await enable(a, c);
    await refused(revokeEnrolment(a), /revoke needs it off/);
    await disable(a);
    await revokeEnrolment(a);
    const row = await first<{
      revoked: number | null;
      credential: string | null;
      revision: number;
    }>(
      db(),
      'SELECT revoked_at AS revoked, credential_id AS credential, revision FROM wallet_provider_accounts WHERE id = ?',
      [a.id],
    );
    expect(row?.revoked).not.toBeNull();
    expect(row).toMatchObject({ credential: null, revision: 0 });
    await refused(enable(a, c), /needs an active source/);
    const audit = await all<{ action: string }>(
      db(),
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'wallet_provider.enrolment_revoke'",
      [a.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('needs its revoke event at the next revision, and cannot be undone', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const at = Date.now();
    await refused(
      run(db(), 'UPDATE wallet_provider_accounts SET revoked_at = ? WHERE id = ?', [at, a.id]),
      /revoke needs its event/,
    );
    await refused(updateEnrolment(a, { revoked_at: at }), /revoke needs its event/);
    await withoutTrigger(db(), 'wallet_enrolment_events_step', () =>
      insertEnrolmentEvent(a, { kind: 'revoke', createdAt: at, revision: 2 }),
    );
    await refused(updateEnrolment(a, { revoked_at: at }, 2), /revoke needs its event/);
    await revokeEnrolment(a);
    await refused(updateEnrolment(a, { revoked_at: null }), /revoke needs its event/);
  });

  it('a legacy row without its credential_id is still refused, and revision 0 still means none', async () => {
    const { org } = await seedOrg();
    const insert = (revision: number, credential: string | null) =>
      run(
        db(),
        `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, revision, credential_id, created_at, updated_at)
         VALUES (?, ?, 'live', 'google', ?, ?, 1, 1)`,
        [uid(), org.id, revision, credential],
      );
    await refused(insert(1, null), /CHECK constraint failed/);
    // The CHECK is under test; the database's own refusal of a new legacy row (0229) fires first, so it is lifted.
    await withoutTrigger(db(), 'wallet_provider_accounts_no_new_legacy_insert', () =>
      refused(insert(0, 'legacy-credential'), /CHECK constraint failed/),
    );
  });
});

describe('credential revoke', () => {
  it('turns every On enrolment on it Off with a disable event, source_revoked, under the revoker', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const live = await enrolment(a.org.id, 'test');
    const idle = await enrolment(b.org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(live, c);
    await setSource(idle, c);
    await enable(live, c);
    await revokeCredential(c.id, 'platform');
    const rows = await all<{ e: number | null; r: number }>(
      db(),
      'SELECT enabled_at AS e, enrolment_revision AS r FROM wallet_provider_accounts WHERE credential_source_id = ? ORDER BY r',
      [c.id],
    );
    expect(rows.map((r) => [r.e, r.r])).toEqual([
      [null, 1],
      [null, 3],
    ]);
    const event = await first(
      db(),
      'SELECT reason, actor_type, kind FROM wallet_enrolment_events WHERE account_id = ? AND enrolment_revision = 3',
      [live.id],
    );
    expect(event).toEqual({ reason: 'source_revoked', actor_type: 'platform', kind: 'disable' });
    const audit = await first(
      db(),
      "SELECT action, org_id FROM audit_log WHERE action = 'wallet_provider.enrolment_disable' AND target_id = ?",
      [live.id],
    );
    expect(audit).toEqual({ action: 'wallet_provider.enrolment_disable', org_id: a.org.id });
    const credentialAudit = await first(
      db(),
      "SELECT org_id FROM audit_log WHERE action = 'wallet_provider.credential_revoke' AND target_id = ?",
      [c.id],
    );
    expect(credentialAudit).toEqual({ org_id: null });
    expect(
      await all(
        db(),
        "SELECT 1 FROM wallet_enrolment_events WHERE account_id = ? AND kind = 'disable'",
        [idle.id],
      ),
    ).toEqual([]);
  });

  it('an event left at the next revision cannot block the revoke', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id, 'test');
    const c = await credential({ scope: 'platform', mode: 'test' });
    await setSource(a, c);
    await enable(a, c);
    // An org writer inserts an unused event at the revision the revoke would take.
    await insertEnrolmentEvent(a, { kind: 'disable' });
    await revokeCredential(c.id, 'platform');
    const row = await first(
      db(),
      'SELECT enabled_at AS e, enrolment_revision AS r FROM wallet_provider_accounts WHERE id = ?',
      [a.id],
    );
    expect(row).toEqual({ e: null, r: 4 });
  });
});
