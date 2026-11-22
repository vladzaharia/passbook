import { beforeAll, describe, expect, it } from 'vitest';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
let staffTpl: string;
beforeAll(async () => {
  f = await tagScanFixture();
  staffTpl = await f.kit.scanTemplate('Staff badge', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    tags: { uses: ['staff', 'member'] },
  });
});

const photoFor = async (passId: string) => {
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    f.kit.ctx,
    { type: 'system', id: null },
    passId,
    { png, includeInPass: false },
    null,
  );
};

const preview = async (s: Awaited<ReturnType<TagScanFixture['desk']>>, card: object) =>
  (await (await f.bind(s, { card, preview: true })).json()) as Record<string, unknown>;

describe('the card a tag preview names', () => {
  it('a staff template opens the whole person by default, a member template one pass', async () => {
    const s = await f.desk({ templateIds: [f.tpl, staffTpl], tags: { assignAll: 'desk' } });
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

  it('opens the person only where this binder may bind a person', async () => {
    const staff = await f.pass({ owner: true, template: staffTpl });
    const scopes = { templateIds: [f.tpl, staffTpl] };
    const desk = await f.desk({ ...scopes });
    expect(await preview(desk, staff.card)).toMatchObject({ opensDefault: 'pass' });
    const open = await f.desk({ ...scopes, tags: { assignAll: 'desk' } });
    expect(await preview(open, staff.card)).toMatchObject({ opensDefault: 'user' });
    const never = await f.desk({ ...scopes, tags: { assignAll: 'never' } });
    expect(await preview(never, staff.card)).toMatchObject({ opensDefault: 'pass' });
    const { scanner } = await f.manager({ ...scopes });
    expect(await preview(scanner, staff.card)).toMatchObject({ opensDefault: 'user' });
  });

  it('the photo redeems for the scanner it was minted for and no other', async () => {
    const s = await f.desk();
    const other = await f.desk();
    const { pass, card } = await f.pass({ owner: true });
    await photoFor(pass.id);
    const url = ((await preview(s, card)) as { card: { photoUrl: string } }).card.photoUrl;
    const path = url.replace('/api/v1/scan', '');
    expect((await f.kit.get(s.headers, path)).status).toBe(200);
    expect((await f.kit.get(other.headers, path)).status).toBe(404);
  });

  it('a manager-only photo is hidden from Desk', async () => {
    const tpl = await f.kit.scanTemplate('Managers see', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, header: {}, photo: { minRole: 'manager' } },
    });
    const s = await f.desk({ templateIds: [tpl] });
    const { pass, card } = await f.pass({ owner: true, template: tpl });
    await photoFor(pass.id);
    expect(
      ((await preview(s, card)) as { card: { photoUrl: string | null } }).card.photoUrl,
    ).toBeNull();
  });

  it('a card of another template is refused, with no photo in the body', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass({ owner: true, template: f.otherTpl });
    await photoFor(pass.id);
    const res = await f.bind(s, { card, preview: true });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('member.png');
  });

  it('a replay and an already-bound answer carry no photo', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass({ owner: true });
    await photoFor(pass.id);
    const idem = key();
    const tag = f.read();
    const body = { idempotencyKey: idem, tag, card };
    const first = (await (await f.kit.post(s.headers, '/tags/bind', body)).json()) as {
      status: string;
      card: { photoUrl: string | null };
    };
    expect(first.status).toBe('bound');
    expect(first.card.photoUrl).toContain('/assets/member.png');
    const again = (await (await f.kit.post(s.headers, '/tags/bind', body)).json()) as {
      card: { photoUrl: string | null };
    };
    expect(again.card.photoUrl).toBeNull();
    const fresh = (await (
      await f.kit.post(s.headers, '/tags/bind', { ...body, idempotencyKey: key() })
    ).json()) as { status: string; card: { photoUrl: string | null } };
    expect(fresh.status).toBe('already_bound');
    expect(fresh.card.photoUrl).toBeNull();
  });
});
