import { beforeAll, describe, expect, it } from 'vitest';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { run } from '../../platform/db.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';
import { insertType, type TypeSpec } from '../scan/tags-policy-test-fixtures.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

let n = 0;
/** A spare tag of a new type made from `spec`. */
async function spare(spec: TypeSpec): Promise<string> {
  const typeId = await insertType(f.kit, f.kit.org.id, spec);
  const id = `spare-${++n}`;
  const ref = `c${n.toString(16).padStart(3, '0')}`.repeat(16);
  await run(
    f.kit.env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, status, created_at)
     VALUES (?, ?, 'live', ?, 'uid', ?, ?, 'active', ?)`,
    [id, f.kit.org.id, ref, typeId, ref.slice(0, 4).toUpperCase(), f.kit.clock.now()],
  );
  return id;
}

const list = async (query: string) => {
  const res = await f.nfc(f.operator.headers, 'GET', `/tags?orgId=${f.kit.org.id}&${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { items: Tag[] }).items.map((t) => t.id);
};

describe('spare tags a pass takes', () => {
  it('lists only the spares whose type the pass policy allows', async () => {
    const { pass } = await f.pass();
    const member = await spare({ use: 'member' });
    const visitor = await spare({ use: 'visitor' });
    const elsewhere = await spare({ templateIds: ['no-such-template'] });
    const userOnly = await spare({ scopes: 'user' });
    const fit = `status=spare&passId=${pass.id}`;
    const ids = await list(`${fit}&binding=pass`);
    expect(ids).toContain(member);
    for (const hidden of [visitor, elsewhere, userOnly]) expect(ids).not.toContain(hidden);
    expect(await list(`${fit}&binding=user`)).toContain(userOnly);
    expect(await list('status=spare')).toEqual(
      expect.arrayContaining([member, visitor, elsewhere, userOnly]),
    );
  });

  it('hides a type the pass already has its limit of', async () => {
    const { pass } = await f.pass();
    const one = await spare({ perPass: 1 });
    const two = await spare({ perPass: 1 });
    const bound = await f.nfc(f.operator.headers, 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId: one,
      binding: 'pass',
    });
    expect(bound.status, await bound.clone().text()).toBe(200);
    expect(await list(`status=spare&passId=${pass.id}`)).not.toContain(two);
  });
});
