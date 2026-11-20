import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { insertType, type TypeSpec } from '../scan/tags-policy-test-fixtures.ts';
import { bindTag } from './tags.ts';
import { reportTagLost, restoreTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture();
});

const DAY = 86_400_000;
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

/** A fresh org with an operator, one type, and a pass. */
async function setup(spec: TypeSpec = {}, options: { owner?: boolean } = {}) {
  const t = await f.org();
  const typeId = await insertType(f.kit, t.org.id, spec);
  const owner = options.owner ? await f.user() : null;
  const pass = await f.pass(t.org.id, { ownerUserId: owner?.id ?? null });
  return { t, typeId, pass, authority: await t.authority() };
}
const bindingOf = (id: string) =>
  first<{ expires_at: number | null; type_id: string | null }>(
    f.kit.env.DB,
    `SELECT b.expires_at, t.type_id FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
     WHERE b.id = ?`,
    [id],
  );

describe('a typed ID from the console', () => {
  it('a type that takes typed IDs binds, with its expiry', async () => {
    const { typeId, pass, authority } = await setup({ bindingDays: 2 });
    const { tag } = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
      typeId,
    });
    expect(tag.type).toMatchObject({ id: typeId });
    expect(tag.binding?.expiresAt).toBe(f.kit.clock.now() + 2 * DAY);
    expect(await bindingOf(tag.binding?.id ?? '')).toMatchObject({ type_id: typeId });
  });

  it('a type that takes tapped tags only refuses a typed ID, whether asked for or picked', async () => {
    const { typeId, pass, authority } = await setup({ typed: false });
    for (const req of [{ typeId }, {}])
      await refused(
        bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass', ...req }),
        'TAG_TYPED_OFF',
      );
    expect(
      (
        await first<{ n: number }>(
          f.kit.env.DB,
          'SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?',
          [pass.id],
        )
      )?.n,
    ).toBe(0);
  });

  it('refuses a Secure type: a typed ID is a UID', async () => {
    const { typeId, pass, authority } = await setup({ system: 'sun' });
    await refused(
      bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass', typeId }),
      'TAG_TYPE_SYSTEM',
    );
  });

  it('applies the limit, the scope and the templates', async () => {
    const one = await setup({ name: 'Wristband' });
    const first = await bindTag(f.kit.ctx, one.authority, {
      uid: f.nextUid(),
      passId: one.pass.id,
      scope: 'pass',
    });
    expect(first.tag.type).toMatchObject({ name: 'Wristband' });
    await refused(
      bindTag(f.kit.ctx, one.authority, { uid: f.nextUid(), passId: one.pass.id, scope: 'pass' }),
      'TAG_TYPE_LIMIT',
    );
    const user = await setup({ scopes: 'pass' }, { owner: true });
    await refused(
      bindTag(f.kit.ctx, user.authority, {
        uid: f.nextUid(),
        passId: user.pass.id,
        scope: 'user',
        typeId: user.typeId,
      }),
      'TAG_TYPE_SCOPE',
    );
  });

  it("another org's type is not found", async () => {
    const a = await setup();
    const b = await setup();
    await refused(
      bindTag(f.kit.ctx, a.authority, {
        uid: f.nextUid(),
        passId: a.pass.id,
        scope: 'pass',
        typeId: b.typeId,
      }),
      'TAG_TYPE_NOT_FOUND',
    );
  });
});

describe('restoring a lost tag', () => {
  it('gives the new binding the type expiry, and keeps the type', async () => {
    const { typeId, pass, authority } = await setup({ bindingDays: 1 });
    const { tag } = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
      typeId,
    });
    await reportTagLost(f.kit.ctx, authority, tag.id);
    const restored = await restoreTag(f.kit.ctx, authority, tag.id);
    expect(restored.binding?.expiresAt).toBe(f.kit.clock.now() + DAY);
    expect(restored.type).toMatchObject({ id: typeId });
  });
});
