import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { readBuildInputs } from './build-reads.ts';
import {
  encoded,
  type MemberPhotoFixture,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';

let fx: MemberPhotoFixture;
beforeAll(async () => {
  fx = await setupPhotoTestKit();
}, 60_000);

describe('what a build reads from D1', () => {
  it('reads the pass assets, member photo and blueprint art in one trip', async () => {
    const { kit } = fx;
    const pass = await kit.pass();
    expect((await fx.api(pass.id, 'PUT', { png: encoded, includeInPass: true })).status).toBe(200);
    const counted = countD1(kit.env.DB);
    const inputs = await readBuildInputs(
      counted.db,
      { passId: pass.id, orgId: kit.org.id },
      pass.templateId,
    );
    expect(counted.count()).toBe(1);
    expect(inputs.photo).toMatchObject({ name: 'thumbnail@3x.png', width: 270 });
    expect(inputs.overrides).toEqual([]);
    expect(inputs.artHashes.size).toBe(0);
  });

  it('reads only the blueprint art when the build omits the pass assets', async () => {
    const { kit } = fx;
    const pass = await kit.pass();
    const counted = countD1(kit.env.DB);
    const inputs = await readBuildInputs(
      counted.db,
      { passId: pass.id, orgId: kit.org.id, omitPassAssets: true },
      pass.templateId,
    );
    expect(counted.count()).toBe(1);
    expect(inputs).toMatchObject({ overrides: [], photo: null });
  });
});
