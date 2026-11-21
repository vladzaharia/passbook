import { beforeAll, describe, expect, it } from 'vitest';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { first, run } from '../../platform/db.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const body = async <T>(r: Response) => (await r.json()) as T;
const assign = (passId: string, req: object, who = f.operator) =>
  f.nfc(who.headers, 'POST', `/passes/${passId}/tags/assign`, req);
const audits = async (action: string, targetId: string) =>
  (
    await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM audit_log WHERE action = ? AND target_id = ?',
      [action, targetId],
    )
  )?.n;

describe('assign a typed tag ID', () => {
  it('binds a new basic tag in any format, once', async () => {
    const p = await f.pass();
    const res = await assign(p.pass.id, { id: '04:A1:B2:C3', binding: 'pass', label: 'Door' });
    expect(res.status, await res.clone().text()).toBe(200);
    const tag = await body<Tag>(res);
    expect(tag).toMatchObject({ assurance: 'basic', label: 'Door', hint: expect.any(String) });
    expect(tag.binding).toMatchObject({ scope: 'pass', passId: p.pass.id });
    expect(await audits('tag.bind', tag.id)).toBe(1);

    const again = await assign(p.pass.id, { id: '04a1b2c3', binding: 'pass' });
    expect((await body<Tag>(again)).id).toBe(tag.id);

    const reversed = await assign((await f.pass()).pass.id, {
      id: 'c3b2a104',
      format: 'reversed',
      binding: 'pass',
    });
    expect(reversed.status).toBe(409);
  });

  it('refuses text that is not a tag ID, a person without an account, and a reader', async () => {
    const p = await f.pass();
    const bad = await assign(p.pass.id, { id: 'nope', binding: 'pass' });
    expect(bad.status).toBe(422);
    expect((await body<{ code: string }>(bad)).code).toBe('TAG_ID_INVALID');
    const noAccount = await assign(p.pass.id, { id: '04a1b2c4', binding: 'user' });
    expect(noAccount.status).toBe(422);
    expect((await body<{ code: string }>(noAccount)).code).toBe('TAG_NO_ACCOUNT');
    expect((await assign(p.pass.id, { id: '04a1b2c5', binding: 'pass' }, f.reader)).status).toBe(
      403,
    );
    expect((await assign(p.pass.id, { id: '04a1b2c5', binding: 'pass' }, f.stranger)).status).toBe(
      404,
    );
  });
});

describe('assign a spare tag', () => {
  it('binds an unassigned tag and refuses one that is assigned', async () => {
    const p = await f.pass();
    const typed = await body<Tag>(await assign(p.pass.id, { id: '04b1b2c3', binding: 'pass' }));
    const bindingId = typed.binding?.id ?? '';
    expect((await f.nfc(f.operator.headers, 'DELETE', `/bindings/${bindingId}`)).status).toBe(200);

    const q = await f.pass();
    const res = await assign(q.pass.id, { tagId: typed.id, binding: 'pass' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await body<Tag>(res)).binding).toMatchObject({ scope: 'pass', passId: q.pass.id });
    expect(await audits('tag.bind', typed.id)).toBe(2);

    const taken = await assign((await f.pass()).pass.id, { tagId: typed.id, binding: 'pass' });
    expect(taken.status).toBe(409);
    expect((await body<{ code: string }>(taken)).code).toBe('TAG_ALREADY_ASSIGNED');
    expect((await assign(q.pass.id, { tagId: 'missing', binding: 'pass' })).status).toBe(404);
  });
});

let sid = 0;
const orgOf = async (passId: string) =>
  (
    await first<{ org_id: string }>(f.kit.env.DB, 'SELECT org_id FROM passes WHERE id = ?', [
      passId,
    ])
  )?.org_id;
const codeOf = async (r: Response) => (await body<{ code: string }>(r)).code;

describe('what the pass and the person allow', () => {
  it.each([
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?", 'TAG_PASS_VOIDED'],
    ['removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', 'TAG_PASS_REMOVED'],
  ])('refuses a %s pass, typed and spare', async (_state, sql, code) => {
    const p = await f.pass();
    const spare = await body<Tag>(
      await assign((await f.pass()).pass.id, {
        id: `04c1${(sid++).toString(16).padStart(4, '0')}`,
        binding: 'pass',
      }),
    );
    await f.nfc(f.operator.headers, 'DELETE', `/bindings/${spare.binding?.id}`);
    await run(f.kit.env.DB, sql, [p.pass.id]);
    const typed = await assign(p.pass.id, { id: '04c1d1e1', binding: 'pass' });
    expect(typed.status).toBe(409);
    expect(await codeOf(typed)).toBe(code);
    const picked = await assign(p.pass.id, { tagId: spare.id, binding: 'pass' });
    expect(picked.status).toBe(409);
    expect(await codeOf(picked)).toBe(code);
  });

  it('refuses a person-wide tag for a disabled owner', async () => {
    const p = await f.pass({ owner: true });
    await run(f.kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [p.ownerId ?? '']);
    const res = await assign(p.pass.id, { id: '04c2d1e1', binding: 'user' });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('TAG_NO_ACCOUNT');
  });

  it('answers another org or mode spare like a missing tag', async () => {
    const p = await f.pass();
    const copy = async (id: string, org: string, mode: string) => {
      const made = `${id}-copy`;
      const ref = '0123456789abcdef'.repeat(4).replace(/^..../, id.length % 2 ? 'abcd' : 'bcde');
      await run(
        f.kit.env.DB,
        `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, status, created_at)
         SELECT ?, ?, ?, ?, system, upper(substr(?, 1, 4)), 'active', created_at FROM nfc_tags LIMIT 1`,
        [made, org, mode, ref, ref],
      );
      return made;
    };
    const elsewhere = await copy('spare-other-org', f.other.id, 'live');
    const testMode = await copy('spare-test-mode', (await orgOf(p.pass.id)) ?? '', 'test');
    const missing = await assign(p.pass.id, { tagId: 'nope', binding: 'pass' });
    const missingCode = await codeOf(missing);
    for (const tagId of [elsewhere, testMode]) {
      const res = await assign(p.pass.id, { tagId, binding: 'pass' });
      expect({ status: res.status, code: await codeOf(res) }).toEqual({
        status: missing.status,
        code: missingCode,
      });
    }
  });

  it('refuses a random 4-byte ID', async () => {
    const res = await assign((await f.pass()).pass.id, { id: '08aabbcc', binding: 'pass' });
    expect(res.status).toBe(422);
  });
});
