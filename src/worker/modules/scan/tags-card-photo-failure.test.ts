import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

vi.mock('./member-photo.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./member-photo.ts')>()),
  knownPhotoUrl: vi.fn().mockRejectedValue(new Error('registry down')),
}));

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

describe('a photo that cannot be minted', () => {
  it('never fails the assign: preview and bind answer 200 with no photo', async () => {
    const s = await f.desk();
    const { card } = await f.pass({ owner: true });
    const preview = await f.bind(s, { card, preview: true });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { card: { photoUrl: unknown } }).card.photoUrl).toBeNull();
    const bound = await f.bind(s, { card });
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ status: 'bound', card: { photoUrl: null } });
  });
});
