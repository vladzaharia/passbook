import { beforeAll, describe, expect, it } from 'vitest';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { first } from '../../platform/db.ts';
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
