import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { enrolledSunTag, sunKeyset } from '../scan/sun-test-fixtures.ts';
import { sunFollowCheck, sunFreshCheck } from './repo-sun.ts';
import { tagGrant } from './repo-tags-write.ts';
import { bindTag } from './tags.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture();
});

describe('an admin typing the ID of a Secure tag', () => {
  it('is refused: a Secure tag is bound by tapping it', async () => {
    const t = await f.org();
    const orgId = t.org.id;
    const ks = await sunKeyset(f.kit, orgId);
    const pass = await f.pass(orgId);
    const uid = f.nextUid();
    await enrolledSunTag(f.kit, ks, uid, { id: pass.id, orgId, mode: 'live' }, 1);
    const other = await f.pass(orgId);
    await expect(
      bindTag(f.kit.ctx, await t.authority(), { uid, passId: other.id, scope: 'pass' }),
    ).rejects.toMatchObject({ code: 'TAG_SECURE_NEEDS_TAP' });
  });
});

describe('a SUN read at commit', () => {
  it('is refused when its keyset was disabled after it was verified, or the slug is not its keyset', async () => {
    const t = await f.org();
    const ks = await sunKeyset(f.kit, t.org.id);
    const pass = await f.pass(t.org.id);
    const { tagId } = await enrolledSunTag(
      f.kit,
      ks,
      f.nextUid(),
      { id: pass.id, orgId: t.org.id, mode: 'live' },
      1,
    );
    const seen = { keysetId: ks.id, slug: ks.slug, keyVersion: 1, ctr: 9 };
    const commit = async (read: typeof seen) => {
      const g = tagGrant(
        f.kit.ctx,
        'org_mode.nfc.tag.update',
        await t.authority(),
        sunFreshCheck(tagId, read),
      );
      g.update('nfc_tags', { set: { label: 'x' }, where: { id: tagId } });
      await g.commit();
    };
    await expect(commit({ ...seen, slug: 'otherslug' })).rejects.toBeDefined();
    await commit(seen);
    await run(f.kit.env.DB, 'UPDATE nfc_tag_keysets SET disabled_at = 1 WHERE id = ?', [ks.id]);
    await expect(commit(seen)).rejects.toBeDefined();
  });
});

describe('a follow-up at commit', () => {
  it('pins the actor and the window in the grant, not only in the read', async () => {
    const t = await f.org();
    const ks = await sunKeyset(f.kit, t.org.id);
    const pass = await f.pass(t.org.id);
    const { tagId } = await enrolledSunTag(
      f.kit,
      ks,
      f.nextUid(),
      { id: pass.id, orgId: t.org.id, mode: 'live' },
      9,
    );
    const at = f.kit.clock.now();
    await run(
      f.kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, actor_type, actor_id, actor_key, idempotency_key, request_hash,
         method, tag_id, sun_ctr, sun_key_version, state, outcome, client_ts, at)
       VALUES ('heads-up-1', ?, 'live', 'scanner', 's', 'door-A', 'k1', 'h', 'nfc', ?, 9, 1, 'done', 'heads_up', 1, ?)`,
      [t.org.id, tagId, at],
    );
    const seen = { keysetId: ks.id, slug: ks.slug, keyVersion: 1, ctr: 9, followUp: 'heads-up-1' };
    const commit = async (actorKey: string, since: number) => {
      const g = tagGrant(
        f.kit.ctx,
        'org_mode.nfc.tag.update',
        await t.authority(),
        sunFollowCheck(tagId, seen, actorKey, since),
      );
      g.update('nfc_tags', { set: { label: 'x' }, where: { id: tagId } });
      await g.commit();
    };
    await expect(commit('door-B', at - 1000)).rejects.toBeDefined();
    await expect(commit('door-A', at + 1)).rejects.toBeDefined();
    await commit('door-A', at - 1000);
  });
});
