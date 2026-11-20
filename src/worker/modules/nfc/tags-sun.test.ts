import { beforeAll, describe, expect, it } from 'vitest';
import { enrolledSunTag, sunKeyset } from '../scan/sun-test-fixtures.ts';
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
