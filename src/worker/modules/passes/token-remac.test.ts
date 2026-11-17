import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { revealToken, tokenMac } from '../../platform/capability-token.ts';
import { first, run } from '../../platform/db.ts';
import { bundleForToken } from '../bundles/public-service.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { passForToken } from '../public/service.ts';
import { readSystemValue } from '../settings/repo.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { remacCapabilityTokens } from './token-remac.ts';

let kit: Kit;
const job = () => jobCtxOf(kit);
const actor = { type: 'system', id: null } as const;
const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const env = () => kit.env as unknown as Record<string, string | undefined>;

beforeAll(async () => {
  kit = await setupKit();
});

const tokens = (passId: string) =>
  first<{
    download_token: string;
    auth_token: string;
    org_id: string;
    row_version: number;
    link_generation: number;
    credential_generation: number;
    gen: number | null;
    dirty: number;
  }>(
    kit.env.DB,
    `SELECT p.download_token, p.auth_token, p.org_id, p.row_version, p.link_generation, p.credential_generation,
       (SELECT generation FROM wallet_provider_pass_authority WHERE pass_id = p.id) AS gen,
       (SELECT count(*) FROM wallet_provider_instance_dirty) AS dirty
     FROM passes p WHERE p.id = ?`,
    [passId],
  );

async function sweepToEnd() {
  for (let i = 0; i < 6; i++) {
    await remacCapabilityTokens(job());
    if ((await readSystemValue(kit.env.DB, 'tokens.remacDone')) !== null) return;
  }
  throw new Error('the sweep did not finish');
}

describe('tokens.remac', () => {
  it('does nothing while no rotation is configured', async () => {
    await remacCapabilityTokens(job());
    expect(await readSystemValue(kit.env.DB, 'tokens.remacCursor')).toBeNull();
    expect(await readSystemValue(kit.env.DB, 'tokens.remacDone')).toBeNull();
  });

  it('moves link, device and bundle MACs to the new root and keeps every link working', async () => {
    const pass = await kit.pass();
    const bundle = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [pass.id], name: 'Rotated' },
      { kind: 'system' },
    );
    const bundlePlain = bundle.url?.split('/b/')[1] ?? '';
    const before = await tokens(pass.id);
    if (!before) throw new Error('missing pass');
    const link = await revealToken(kit.env, 'pass', pass.id, before.org_id, before.download_token);
    const device = await revealToken(
      kit.env,
      'apple-auth',
      pass.id,
      before.org_id,
      before.auth_token,
    );
    const bundleRow = await first<{ token: string }>(
      kit.env.DB,
      'SELECT token FROM bundles WHERE id = ?',
      [bundle.id],
    );

    env().KEK_V2 = kek(2);
    env().MAC_KEY_VERSION = '2';
    env().MAC_KEY_VERSION_PREVIOUS = '1';
    // Mid-rotation the rows still hold the old MACs and every lookup still finds them.
    expect(await passForToken(job(), link)).toMatchObject({ id: pass.id });
    expect(await bundleForToken(job(), bundlePlain)).toMatchObject({ id: bundle.id });

    await sweepToEnd();

    const after = await tokens(pass.id);
    expect(after?.download_token).toBe(await tokenMac(kit.env, 'pass', link));
    expect(after?.auth_token).toBe(await tokenMac(kit.env, 'apple-auth', device));
    expect(after?.download_token).not.toBe(before.download_token);
    expect(after?.auth_token).not.toBe(before.auth_token);
    const bundleAfter = await first<{ token: string }>(
      kit.env.DB,
      'SELECT token FROM bundles WHERE id = ?',
      [bundle.id],
    );
    expect(bundleAfter?.token).toBe(await tokenMac(kit.env, 'bundle', bundlePlain));
    expect(bundleAfter?.token).not.toBe(bundleRow?.token);
    // Not a rotation, a transfer or a pass change.
    expect(after).toMatchObject({
      row_version: before.row_version,
      link_generation: before.link_generation,
      credential_generation: before.credential_generation,
      gen: before.gen,
      dirty: before.dirty,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM token_remac_marks WHERE pass_id = ?', [pass.id]),
    ).toBeNull();

    // With the previous root unset, only the rewritten MACs resolve.
    delete env().MAC_KEY_VERSION_PREVIOUS;
    expect(await passForToken(job(), link)).toMatchObject({ id: pass.id });
    expect(await bundleForToken(job(), bundlePlain)).toMatchObject({ id: bundle.id });
    expect(
      await revealToken(
        kit.env,
        'apple-auth',
        pass.id,
        after?.org_id ?? '',
        after?.auth_token ?? '',
      ),
    ).toBe(device);

    // A finished rotation is recorded and the job stops.
    env().MAC_KEY_VERSION_PREVIOUS = '1';
    const rows = await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM passes');
    await remacCapabilityTokens(job());
    expect((await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM passes'))?.n).toBe(
      rows?.n,
    );
    expect(await readSystemValue(kit.env.DB, 'tokens.remacDone')).toBe('1>2');
  });

  it('counts a row with no sealed copy and leaves it on the previous root', async () => {
    const orphan = await kit.pass();
    await run(kit.env.DB, 'DELETE FROM pass_token_seals WHERE pass_id = ?', [orphan.id]);
    const stored = (await tokens(orphan.id))?.download_token;
    await run(
      kit.env.DB,
      "DELETE FROM settings WHERE scope = 'system' AND key = 'tokens.remacDone'",
    );
    env().MAC_KEY_VERSION = '2';
    env().MAC_KEY_VERSION_PREVIOUS = '1';
    await sweepToEnd();
    expect((await tokens(orphan.id))?.download_token).toBe(stored);
  });

  it('skips a pass with a pending credential transfer and sweeps again until it settles', async () => {
    const pass = await kit.pass();
    await remacCapabilityTokens(job());
    // The pass was made under the new root already; put it back on the previous one.
    const link = await revealToken(kit.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
    const old = await tokenMac(kit.env, 'pass', link, 1);
    await run(kit.env.DB, 'DELETE FROM token_remac_marks');
    await run(kit.env.DB, 'INSERT INTO token_remac_marks (pass_id, kind, mac) VALUES (?, ?, ?)', [
      pass.id,
      'download',
      old,
    ]);
    await run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [old, pass.id]);
    await run(kit.env.DB, 'DELETE FROM token_remac_marks');
    await run(
      kit.env.DB,
      `INSERT INTO pass_credential_transfers
       (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
        source_lifecycle_generation, source_link_generation, requested_by_type, requested_at)
       SELECT ?, p.id, p.org_id, p.mode, 'pending', p.credential_generation, p.version, p.revision, p.row_version,
        p.lifecycle_generation, p.link_generation + 1, 'system', ? FROM passes p WHERE p.id = ?`,
      [kit.fx.ids.id(), kit.clock.now(), pass.id],
    );
    await run(
      kit.env.DB,
      "DELETE FROM settings WHERE scope = 'system' AND key = 'tokens.remacDone'",
    );
    await sweepToEnd().catch(() => undefined);
    expect((await tokens(pass.id))?.download_token).toBe(old);
    expect(await readSystemValue(kit.env.DB, 'tokens.remacDone')).toBeNull();
    await withoutTrigger(kit.env.DB, 'pass_credential_transfer_no_delete', () =>
      run(kit.env.DB, 'DELETE FROM pass_credential_transfers WHERE pass_id = ?', [pass.id]),
    );
    await sweepToEnd();
    expect((await tokens(pass.id))?.download_token).toBe(await tokenMac(kit.env, 'pass', link));
  });

  it('refuses a MAC-for-MAC change outside the job', async () => {
    const pass = await kit.pass();
    await expect(
      run(kit.env.DB, "UPDATE passes SET download_token = 'h1:forgot' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/must move link_generation/);
    await expect(
      run(kit.env.DB, "UPDATE passes SET auth_token = 'h1:forgot' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/credential transfer required|credential generation bump/);
  });
});
