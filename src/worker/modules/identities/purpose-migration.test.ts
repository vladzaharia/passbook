/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0234_platform_identities.sql?raw';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

describe('0234 platform identities', () => {
  it('adds purpose, defaulting to passes, and holds devtest for the platform', async () => {
    const { env } = await setupKit();
    expect(
      await first(env.DB, "SELECT purpose FROM signing_identities WHERE id = 'platform'"),
    ).toEqual({ purpose: 'passes' });
    expect(
      await first(env.DB, "SELECT org_id FROM identity_handles WHERE handle = 'devtest'"),
    ).toEqual({ org_id: null });
    await expect(
      run(env.DB, "UPDATE signing_identities SET purpose = 'other' WHERE id = 'platform'"),
    ).rejects.toThrow(/CHECK/);
  });

  it('fails the migration when an org already holds devtest', async () => {
    const kit = await setupKit();
    const org = await makeOrg(kit.fx, { slug: 'holder', name: 'Holder' });
    const check = /SELECT json\([\s\S]*?;/.exec(migration)?.[0] ?? '';
    expect(check).not.toBe('');
    await run(kit.env.DB, check);
    await run(kit.env.DB, 'DROP TRIGGER identity_handles_no_reassign');
    await run(kit.env.DB, "UPDATE identity_handles SET org_id = ? WHERE handle = 'devtest'", [
      org.id,
    ]);
    await expect(run(kit.env.DB, check)).rejects.toThrow(/malformed JSON/);
  });
});
