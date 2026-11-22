import { beforeAll, describe, expect, it } from 'vitest';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
let staffTpl: string;
beforeAll(async () => {
  f = await tagScanFixture();
  staffTpl = await f.kit.scanTemplate('Staff badge', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    tags: { uses: ['staff', 'member'] },
  });
});

const preview = async (s: Awaited<ReturnType<TagScanFixture['desk']>>, card: object) =>
  (await (await f.bind(s, { card, preview: true })).json()) as Record<string, unknown>;

describe('the card a tag preview names', () => {
  it('a staff template opens the whole person by default, a member template one pass', async () => {
    const s = await f.desk({ templateIds: [f.tpl, staffTpl] });
    const staff = await f.pass({ owner: true, template: staffTpl });
    const member = await f.pass({ owner: true });
    expect(await preview(s, staff.card)).toMatchObject({ opensDefault: 'user' });
    expect(await preview(s, member.card)).toMatchObject({ opensDefault: 'pass' });
  });

  it('carries the holder photo to the confirm card, and null without one', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass({ owner: true });
    const before = (await preview(s, card)) as { card: { photoUrl: string | null } };
    expect(before.card.photoUrl).toBeNull();
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      f.kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const after = (await preview(s, card)) as { card: { photoUrl: string | null } };
    expect(after.card.photoUrl).toContain('/assets/member.png');
    expect(after.card.photoUrl).toContain('g=');
  });

  it('no photo is shown where the scanner hides photos', async () => {
    const s = await f.desk({ settings: { showPhoto: false } });
    const { pass, card } = await f.pass({ owner: true });
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      f.kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    expect(
      ((await preview(s, card)) as { card: { photoUrl: string | null } }).card.photoUrl,
    ).toBeNull();
  });
});
