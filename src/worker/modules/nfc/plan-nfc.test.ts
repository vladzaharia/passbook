import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { passFacts } from './repo-tag-bindings.ts';
import { addBind, type BindPlan, bindChecks, tagGrant } from './repo-tags-write.ts';
import { UID_SYSTEM } from './systems/uid.ts';
import { bindTag, commitTag } from './tags.ts';
import { retireTag, unbindTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture();
});

const preset = (orgId: string, value: string) =>
  run(f.kit.env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [value, orgId]);
const level = (orgId: string, value: string) =>
  run(
    f.kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'nfc', ?, 1)`,
    [orgId, JSON.stringify(value)],
  );
const active = (orgId: string) =>
  all<{ id: string }>(
    f.kit.env.DB,
    `SELECT b.id FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
     WHERE t.org_id = ? AND b.ended_at IS NULL`,
    [orgId],
  );
const notIncluded = { status: 403, code: 'FEATURE_NOT_INCLUDED' };

describe('the nfc level: tag bind', () => {
  it('a legacy org binds as before', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const { status } = await bindTag(f.kit.ctx, await t.authority(), {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    expect(status).toBe('bound');
  });

  it('refuses a bind while the plan has nfc off, and binds again once it is Basic', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    await preset(t.org.id, 'trial');
    await expect(
      bindTag(f.kit.ctx, await t.authority(), { uid: f.nextUid(), passId: pass.id, scope: 'pass' }),
    ).rejects.toMatchObject({ ...notIncluded, feature: 'nfc' });
    expect(await active(t.org.id)).toHaveLength(0);

    await level(t.org.id, 'basic');
    const { status } = await bindTag(f.kit.ctx, await t.authority(), {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    expect(status).toBe('bound');
  });

  it('a downgrade pauses: bindings stay and can still end, retire and be listed', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const authority = await t.authority();
    const first = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    const second = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: (await f.pass(t.org.id)).id,
      scope: 'pass',
    });
    await preset(t.org.id, 'trial');
    expect(await active(t.org.id)).toHaveLength(2);
    // Ending a binding and retiring a tag never need the plan.
    await unbindTag(f.kit.ctx, authority, first.tag.binding?.id ?? '');
    await retireTag(f.kit.ctx, authority, second.tag.id);
    expect(await active(t.org.id)).toHaveLength(0);
  });

  it('the grant is the backstop: a write that got past the service check still refuses', async () => {
    const t = await f.org();
    const pass = await f.pass(t.org.id);
    const authority = await t.authority();
    const facts = await passFacts(f.kit.env.DB, pass.id);
    const { ref, hint } = await UID_SYSTEM.identify(f.kit.env, t.org.id, 'live', f.nextUid());
    const grant = () => {
      const plan: BindPlan = {
        tagId: f.kit.ctx.ids.id(),
        newTag: { system: UID_SYSTEM.id, ref, hint, label: null },
        bindingId: f.kit.ctx.ids.id(),
        passId: pass.id,
        scope: 'pass',
        userId: null,
        end: null,
        holderGeneration: facts?.credentialGeneration ?? 1,
        holderOwner: facts?.ownerUserId ?? null,
        clearsLost: false,
        source: 'admin',
        actor: { type: 'user', id: authority.userId },
        scannerId: null,
        orgId: t.org.id,
        mode: 'live',
      };
      const g = tagGrant(f.kit.ctx, 'org_mode.nfc.tag.bind', authority, bindChecks(plan));
      addBind(g, f.kit.ctx, plan);
      return g;
    };
    await preset(t.org.id, 'trial');
    await expect(commitTag(grant())).rejects.toMatchObject(notIncluded);
    expect(await active(t.org.id)).toHaveLength(0);
    await level(t.org.id, 'basic');
    await commitTag(grant());
    expect(await active(t.org.id)).toHaveLength(1);
  });
});
