import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { NEW_CODES_PER_HOUR, newPassCode } from '../passes/new-code.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

const system = { type: 'system', id: null } as const;
const rotate = (passId: string) => newPassCode(jobCtxOf({ ctx: kit.ctx }), system, passId, null);
const pushes = (passId: string) =>
  all<{ id: number }>(
    kit.env.DB,
    "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'push.queued'",
    [passId],
  );

describe('New code', () => {
  it('rotates in place: same serial and token, old code refused, new code admitted, push queued', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'holder@example.com' });
    const before = codeOf(pass);
    expect((await out(await act(s.headers, before))).kind).toBe('ok');
    const pushed = (await pushes(pass.id)).length;

    await rotate(pass.id);

    const after = await getPass(kit.env.DB, pass.id);
    expect(after).toMatchObject({
      serial: pass.serial,
      authToken: pass.authToken,
      holderEmail: 'holder@example.com',
      credentialGeneration: pass.credentialGeneration,
    });
    expect(after?.version).toBe(pass.version + 1);
    expect(after?.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(after?.scanCode).not.toBe(pass.scanCode);
    expect((await pushes(pass.id)).length).toBe(pushed + 1);
    expect(await out(await act(s.headers, before))).toMatchObject({
      kind: 'refused',
      reason: 'code_replaced',
      card: null,
      action: null,
      display: null,
    });
    const admitted = await out(await act(s.headers, codeOf(after as never)));
    expect(admitted.kind).not.toBe('refused');
    const row = await first<{ barcode_hash: string }>(
      kit.env.DB,
      'SELECT barcode_hash FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.barcode_hash).toHaveLength(64);
  });

  it('reads a rotated-out code as not found in another org', async () => {
    const pass = await kit.scanPass(tpl);
    const before = codeOf(pass);
    await rotate(pass.id);
    const foreign = await makeOrg(kit.fx);
    const s = await kit.scanner({ orgId: foreign.id, settings: { acceptAllTemplates: true } });
    expect(await out(await act(s.headers, before))).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
    });
  });

  it('refuses a scan code change without its mark and allows it with one', async () => {
    const pass = await kit.scanPass(tpl);
    const change = (code: string) =>
      run(kit.env.DB, 'UPDATE passes SET scan_code = ?, version = version + 1 WHERE id = ?', [
        code,
        pass.id,
      ]);
    await expect(change('A'.repeat(26))).rejects.toThrow(/credential transfer required/);
    const mark = kit.env.DB.prepare(
      `INSERT INTO scan_code_rotations
       (pass_id, org_id, mode, old_code_hash, new_version, rotated_at, actor_type)
       VALUES (?, ?, ?, ?, ?, 0, 'system')`,
    );
    // The mark must name the version the write creates.
    await expect(
      kit.env.DB.batch([
        mark.bind(pass.id, pass.orgId, pass.mode, 'a'.repeat(64), pass.version + 2),
      ]),
    ).rejects.toThrow(/invalid scan code rotation/);
    await kit.env.DB.batch([
      mark.bind(pass.id, pass.orgId, pass.mode, 'a'.repeat(64), pass.version + 1),
      kit.env.DB.prepare(
        'UPDATE passes SET scan_code = ?, version = version + 1 WHERE id = ?',
      ).bind('B'.repeat(26), pass.id),
    ]);
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).toBe('B'.repeat(26));
  });

  it('keeps marks append-only and drops them with the pass', async () => {
    const pass = await kit.scanPass(tpl);
    await rotate(pass.id);
    const marks = () =>
      all(kit.env.DB, 'SELECT 1 FROM scan_code_rotations WHERE pass_id = ?', [pass.id]);
    expect(await marks()).toHaveLength(1);
    await expect(
      run(kit.env.DB, 'DELETE FROM scan_code_rotations WHERE pass_id = ?', [pass.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(kit.env.DB, "UPDATE scan_code_rotations SET actor_type = 'x' WHERE pass_id = ?", [
        pass.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await marks()).toHaveLength(0);
  });

  it('writes an audit row without the code', async () => {
    const pass = await kit.scanPass(tpl);
    await rotate(pass.id);
    const rows = await all<{ action: string; detail: string | null }>(
      kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE action = 'pass.new_code' AND target_id = ?",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    const now = await getPass(kit.env.DB, pass.id);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(pass.scanCode as string);
    expect(text).not.toContain(now?.scanCode as string);
  });

  it('limits a pass to a few new codes an hour', async () => {
    const pass = await kit.scanPass(tpl);
    for (let i = 0; i < NEW_CODES_PER_HOUR; i++) await rotate(pass.id);
    await expect(rotate(pass.id)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('refuses a template whose barcode is not the scan code', async () => {
    const pass = await kit.pass();
    await expect(rotate(pass.id)).rejects.toMatchObject({
      status: 409,
      code: 'NEW_CODE_UNSUPPORTED',
    });
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).toBe(pass.scanCode);
  });

  it('shows the new code in a bundle that holds the pass', async () => {
    const fake = fakeAuth('https://wallet.test');
    const app = createApp({ stores: fake.stores, clock: kit.clock });
    const pass = await kit.scanPass(tpl);
    const headers = fake.admin();
    await seedBundlePrincipal(kit, fake, headers);
    const made = await app.request(
      'https://wallet.test/api/v1/bundles',
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: kit.org.id, name: 'Trip', passIds: [pass.id] }),
      },
      kit.env,
    );
    const token = BundleSchema.parse(await made.json()).url?.split('/b/')[1] ?? '';
    await rotate(pass.id);
    const res = await app.request(
      `https://wallet.test/b/${token}/${pass.id}/pass.pkpass`,
      {},
      kit.env,
    );
    if (res.status !== 200) await expectProblem(res, 200, 'x');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const json = JSON.parse(new TextDecoder().decode(files['pass.json'])) as {
      barcodes: { message: string }[];
    };
    const now = await getPass(kit.env.DB, pass.id);
    expect(json.barcodes[0]?.message).toBe(now?.scanCode);
    expect(json.barcodes[0]?.message).not.toBe(pass.scanCode);
  });
});
