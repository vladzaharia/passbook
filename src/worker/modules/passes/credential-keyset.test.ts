import { describe, expect, it } from 'vitest';
import {
  envA,
  envB,
  expectKeysetInitializationBlocked,
  installKeysetTestEnv,
  keyA,
  keyB,
  tombstoneWithoutKeyset,
  unavailable,
} from '../../../../test/helpers/credential-keyset.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { toHex } from '../../platform/ids.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from './credential-keyset.ts';
import { credentialRefKeysetSql } from './repo-credential-keyset.ts';

const makeEnv = installKeysetTestEnv();

describe.sequential('credential reference keyset', () => {
  it('commits to the tombstone key with a separate fixed HMAC domain', async () => {
    const key = await derivedHmacKey(envA, 'pass-credential-tombstone-v1');
    const expected = toHex(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode('pass-credential-ref-keyset-v1'),
        ),
      ),
    );
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(await credentialRefKeysetCommitment(envA)).toBe(expected);
    expect(await credentialRefKeysetCommitment(envB)).not.toBe(expected);
    expect(credentialRefKeysetSql).toBe(
      'EXISTS (SELECT 1 FROM credential_ref_keyset WHERE id = 1 AND commitment = ?)',
    );
  });

  it('snapshots only own enumerable string KEKs before asynchronous work', async () => {
    const env: { KEK_V1: string; KEK_V2?: string } = Object.assign(
      Object.create({ KEK_V3: keyB }) as Record<string, unknown>,
      {
        KEK_V1: keyA,
        KEK_V2: keyB,
        KEK_V4: '',
        KEK_V5: 12,
        KEK_V1_extra: keyB,
        kek_v6: keyB,
        SECRET: 'not-a-kek',
      },
    );
    Object.defineProperty(env, 'KEK_V6', { value: keyB, enumerable: false });
    const snapshot = captureCredentialKeyEnv(env);
    expect(snapshot).toEqual({ KEK_V1: keyA, KEK_V2: keyB, KEK_V4: '' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'KEK_V1', keyB)).toBe(false);
    const pending = credentialRefKeysetCommitment(snapshot);
    env.KEK_V1 = keyB;
    delete env.KEK_V2;
    expect(await pending).toBe(await credentialRefKeysetCommitment(envA));
    expect(await credentialRefKeysetCommitment(env)).not.toBe(await pending);
  });

  it('only initializes on an eligible operation; read-only validation never creates a row', async () => {
    const { DB: db } = await makeEnv();
    await expect(requireCredentialRefKeyset(db, envA)).rejects.toMatchObject(unavailable);
    expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
    const commitment = await ensureCredentialRefKeyset(db, envA);
    expect(commitment).toBe(await credentialRefKeysetCommitment(envA));
    expect(await first(db, 'SELECT id, commitment FROM credential_ref_keyset')).toEqual({
      id: 1,
      commitment,
    });
    expect(await ensureCredentialRefKeyset(db, envA)).toBe(commitment);
    expect(await requireCredentialRefKeyset(db, envA)).toBe(commitment);
  });

  it('does not initialize without a valid configured KEK', async () => {
    const { DB: db } = await makeEnv();
    const configUnavailable = { status: 503, code: 'CREDENTIAL_REF_KEYSET_CONFIG_UNAVAILABLE' };
    for (const env of [{}, { KEK_V1: btoa('short') }, { KEK_V1: 'not base64!' }]) {
      await expect(credentialRefKeysetCommitment(env)).rejects.toMatchObject(configUnavailable);
      await expect(ensureCredentialRefKeyset(db, env)).rejects.toMatchObject(configUnavailable);
      await expect(requireCredentialRefKeyset(db, env)).rejects.toMatchObject(configUnavailable);
    }
    expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
  });

  it('preserves D1 errors instead of classifying them as keyset failures', async () => {
    const { DB: real } = await makeEnv();
    const failure = new Error('D1 unavailable');
    const db = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return () => {
            throw failure;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(ensureCredentialRefKeyset(db, envA)).rejects.toBe(failure);
    await expect(requireCredentialRefKeyset(db, envA)).rejects.toBe(failure);
  });

  it('serializes competing first initializations and rejects the losing key', async () => {
    const { DB: db } = await makeEnv();
    const [a, b] = await Promise.all([
      credentialRefKeysetCommitment(envA),
      credentialRefKeysetCommitment(envB),
    ]);
    const results = await Promise.allSettled([
      ensureCredentialRefKeyset(db, envA),
      ensureCredentialRefKeyset(db, envB),
    ]);
    const winners = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const losers = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject(unavailable);
    expect([a, b]).toContain(winners[0]);
    expect(await first(db, 'SELECT id, commitment FROM credential_ref_keyset')).toEqual({
      id: 1,
      commitment: winners[0],
    });
    const loserEnv = winners[0] === a ? envB : envA;
    await expect(requireCredentialRefKeyset(db, loserEnv)).rejects.toMatchObject(unavailable);
    await expect(ensureCredentialRefKeyset(db, loserEnv)).rejects.toMatchObject(unavailable);
  });

  it('allows concurrent initializations with the same key', async () => {
    const { DB: db } = await makeEnv();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureCredentialRefKeyset(db, envA)),
    );
    expect(new Set(results).size).toBe(1);
    expect(await first(db, 'SELECT COUNT(*) AS n FROM credential_ref_keyset')).toEqual({ n: 1 });
  });

  it('pins the oldest KEK, allows adding a newer KEK, and rejects removal or replacement', async () => {
    const { DB: db } = await makeEnv();
    const initial = await ensureCredentialRefKeyset(db, envA);
    expect(await ensureCredentialRefKeyset(db, { KEK_V1: keyA, KEK_V2: keyB })).toBe(initial);
    await expect(ensureCredentialRefKeyset(db, { KEK_V2: keyB })).rejects.toMatchObject(
      unavailable,
    );
    await expect(requireCredentialRefKeyset(db, { KEK_V2: keyB })).rejects.toMatchObject(
      unavailable,
    );
    await expect(ensureCredentialRefKeyset(db, envB)).rejects.toMatchObject(unavailable);
    expect(await first(db, 'SELECT id, commitment FROM credential_ref_keyset')).toEqual({
      id: 1,
      commitment: initial,
    });
    expect(await requireCredentialRefKeyset(db, { KEK_V1: keyA, KEK_V2: keyB })).toBe(initial);
  });

  it('prevents singleton update, deletion, replacement, and insertion at another id', async () => {
    const { DB: db } = await makeEnv();
    const commitment = await credentialRefKeysetCommitment(envA);
    // Exercise the id constraint while no singleton exists, rather than the insert guard.
    await expect(
      run(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (2, ?)', [commitment]),
    ).rejects.toThrow('CHECK constraint failed');
    expect(await first(db, 'SELECT * FROM credential_ref_keyset')).toBeNull();
    expect(
      await run(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
        commitment,
      ]),
    ).toEqual({ changes: 1 });
    await expect(requireCredentialRefKeyset(db, envA)).resolves.toBe(commitment);
    await expect(
      run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', ['c'.repeat(64)]),
    ).rejects.toThrow('credential reference keyset is immutable');
    await expect(
      run(db, 'UPDATE credential_ref_keyset SET commitment = commitment WHERE id = 1'),
    ).rejects.toThrow('credential reference keyset is immutable');
    await expect(run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1')).rejects.toThrow(
      'credential reference keyset is immutable',
    );
    await expect(
      run(db, 'INSERT OR REPLACE INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
        commitment,
      ]),
    ).rejects.toThrow('credential reference keyset cannot be initialized');
    await expect(
      run(db, 'INSERT OR REPLACE INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
        'c'.repeat(64),
      ]),
    ).rejects.toThrow('credential reference keyset cannot be initialized');
    expect(await requireCredentialRefKeyset(db, envA)).toBe(commitment);
  });

  it('fails closed on a preexisting tombstone without a singleton', async () => {
    const { DB: db } = await makeEnv();
    await tombstoneWithoutKeyset(db);
    await expectKeysetInitializationBlocked(db);
    await expect(requireCredentialRefKeyset(db, envA)).rejects.toMatchObject(unavailable);
  });
});
