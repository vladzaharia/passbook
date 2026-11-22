import { beforeAll, describe, expect, it } from 'vitest';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { run } from '../../platform/db.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';
import { insertType, type TypeSpec } from '../scan/tags-policy-test-fixtures.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

let n = 0;
/** A spare tag of `typeId`, or of a new type made from `spec`. */
async function spare(spec: TypeSpec, typeId?: string): Promise<{ id: string; typeId: string }> {
  const type = typeId ?? (await insertType(f.kit, f.kit.org.id, spec));
  const id = `spare-${++n}`;
  const ref = `c${n.toString(16).padStart(3, '0')}`.repeat(16);
  await run(
    f.kit.env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, status, created_at)
     VALUES (?, ?, 'live', ?, 'uid', ?, ?, 'active', ?)`,
    [id, f.kit.org.id, ref, type, ref.slice(0, 4).toUpperCase(), f.kit.clock.now()],
  );
  return { id, typeId: type };
}

const list = async (query: string) => {
  const res = await f.nfc(f.operator.headers, 'GET', `/tags?orgId=${f.kit.org.id}&${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { items: Tag[] }).items.map((t) => t.id);
};

describe('spare tags a pass takes', () => {
  it('lists only the spares whose type the pass policy allows', async () => {
    const { pass } = await f.pass();
    const staffOnly = await f.kit.scanTemplate('Staff area', {
      actions: [CHECK_IN],
      tags: { uses: ['staff'] },
    });
    const staffPass = (await f.pass({ template: staffOnly })).pass;
    const pool = await f.kit.scanTemplate('Pool card', { actions: [CHECK_IN] });
    const member = await spare({ use: 'member' });
    const staff = await spare({ use: 'staff' });
    const elsewhere = await spare({ templateIds: [pool] });
    const userOnly = await spare({ scopes: 'user' });
    const query = (p: string, binding = 'pass') => `status=spare&passId=${p}&binding=${binding}`;

    const ids = await list(query(pass.id));
    expect(ids).toEqual(expect.arrayContaining([member.id, staff.id]));
    for (const hidden of [elsewhere, userOnly]) expect(ids).not.toContain(hidden.id);
    expect(await list(query(pass.id, 'user'))).toContain(userOnly.id);

    const staffIds = await list(query(staffPass.id));
    expect(staffIds).toContain(staff.id);
    expect(staffIds).not.toContain(member.id);

    expect(await list('status=spare')).toEqual(
      expect.arrayContaining([member, staff, elsewhere, userOnly].map((t) => t.id)),
    );
  });

  it('hides a type the pass already has its limit of', async () => {
    const { pass } = await f.pass();
    const one = await spare({ perPass: 1 });
    const two = await spare({}, one.typeId);
    const other = await spare({ perPass: 1 });
    const bound = await f.nfc(f.operator.headers, 'POST', `/passes/${pass.id}/tags/assign`, {
      tagId: one.id,
      binding: 'pass',
    });
    expect(bound.status, await bound.clone().text()).toBe(200);
    const ids = await list(`status=spare&passId=${pass.id}`);
    expect(ids).not.toContain(two.id);
    expect(ids).toContain(other.id);
  });
});
