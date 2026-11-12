import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { captureCredentialKeyset, credentialKeysetContext } from './credential-keyset-authority.ts';

describe('authorized scanner credential keyset', () => {
  it('does not initialize a keyset when the captured authority is denied', async () => {
    const env = await makeEnv();
    const ctx = credentialKeysetContext(createServiceContext(env));
    expect(await captureCredentialKeyset(ctx, { sql: '0', params: [] })).toBeNull();
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toBeNull();
  });

  it('initializes an empty store only under authority and rejects a mismatched key ring', async () => {
    const env = await makeEnv();
    const ctx = credentialKeysetContext(createServiceContext(env));
    const original = await captureCredentialKeyset(ctx, { sql: '1', params: [] });
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toEqual({ commitment: original });
    const alternate =
      env.KEK_V1 === btoa('z'.repeat(32)) ? btoa('y'.repeat(32)) : btoa('z'.repeat(32));
    const wrong = credentialKeysetContext(createServiceContext({ ...env, KEK_V1: alternate }));
    await expect(captureCredentialKeyset(wrong, { sql: '1', params: [] })).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toEqual({ commitment: original });
  });

  it('pins the complete request key ring before asynchronous work', async () => {
    const env = await makeEnv();
    const initial = env.KEK_V1;
    const ctx = credentialKeysetContext(createServiceContext(env));
    expect(Object.isFrozen(ctx.env)).toBe(true);
    const original = await credentialRefKeysetCommitment(ctx.env);
    Object.assign(env, { KEK_V1: btoa('z'.repeat(32)), KEK_V99: btoa('y'.repeat(32)) });
    expect(ctx.env.KEK_V1).toBe(initial);
    expect(Object.hasOwn(ctx.env, 'KEK_V99')).toBe(false);
    expect(await captureCredentialKeyset(ctx, { sql: '1', params: [] })).toBe(original);
  });
});
