import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { assertBindable } from '../nfc/pass-state.ts';
import { candidateById } from './repo-lookup.ts';
import { candidateTakesTag, skippedTitles } from './tag-assurance.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';
import { key } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let f: TagScanFixture;
let secure: string;
beforeAll(async () => {
  f = await tagScanFixture();
  secure = await f.kit.scanTemplate('Staff badge', {
    actions: [CHECK_IN],
    tags: { min: 'secure' },
  });
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const tagInput = (tag: unknown, extra: Record<string, unknown> = {}) => ({
  tag,
  method: 'nfc',
  ...extra,
});
const post = (
  s: { headers: Record<string, string> },
  path: '/resolve' | '/actions',
  input: unknown,
) =>
  f.kit
    .post(s.headers, path, {
      idempotencyKey: key(),
      input,
      clientTs: f.kit.clock.now(),
      ...(path === '/actions' ? { actionId: 'auto' } : {}),
    })
    .then(json);

describe('template tag minimum', () => {
  it('refuses to bind a Basic tag to a pass whose template needs a secure one', async () => {
    const s = await f.desk({ templateIds: [f.tpl, secure] });
    const { card } = await f.pass({ template: secure });
    for (const preview of [false, true]) {
      const res = await f.bind(s, { card, preview });
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: 'TAG_ASSURANCE_LOW' });
    }
    expect((await f.active()).length).toBe(0);
  });

  it('treats an explicit basic like no setting', async () => {
    const t = await f.kit.scanTemplate('Explicit', { actions: [CHECK_IN], tags: { min: 'basic' } });
    const s = await f.desk({ templateIds: [t] });
    const { card } = await f.pass({ template: t });
    expect((await f.bind(s, { card })).status).toBe(200);
  });

  it('leaves a template without a minimum unchanged', async () => {
    const s = await f.desk({ templateIds: [f.otherTpl] });
    const { card } = await f.pass({ template: f.otherTpl });
    expect((await f.bind(s, { card })).status).toBe(200);
  });

  it('refuses a console bind of a secure pass and fails closed on an unreadable snapshot', async () => {
    const { pass } = await f.pass({ template: secure });
    await expect(assertBindable(f.kit.ctx, f.kit.org.id, pass.id)).rejects.toMatchObject({
      code: 'TAG_ASSURANCE_LOW',
    });
    const { pass: basic } = await f.pass();
    await expect(assertBindable(f.kit.ctx, f.kit.org.id, basic.id)).resolves.toBeUndefined();
    const candidate = await candidateById(f.kit.env.DB, f.kit.org.id, basic.id);
    if (!candidate) throw new Error('no candidate');
    expect(candidateTakesTag(f.kit.ctx, candidate)).toBe(true);
    expect(resolveCandidateReadTemplates(candidate)).not.toBeNull();
    const unreadable = { ...candidate, templateSnapshot: null };
    expect(candidateTakesTag(f.kit.ctx, unreadable)).toBe(false);
  });

  it('a user fob opens basic passes, skips secure ones, and the preview names them', async () => {
    const s = await f.manager();
    const mgr = { headers: s.scanner.headers };
    const user = (await f.pass({ owner: true })) as Awaited<ReturnType<typeof f.pass>>;
    const owner = user.ownerId ?? '';
    await f.pass({ template: secure, ownerId: owner });
    const preview = await json(
      await f.bind(s.scanner, { card: user.card, binding: 'user', preview: true }),
    );
    expect(preview).toMatchObject({ status: 'preview', skipped: [expect.any(String)] });
    expect(await skippedTitles(f.kit.ctx, f.kit.org.id, 'live', owner)).toHaveLength(1);
    const tag = f.read();
    const bound = await f.bind(s.scanner, { card: user.card, binding: 'user', tag });
    expect(bound.status).toBe(200);
    const resolved = await post(mgr, '/resolve', tagInput(tag));
    expect(resolved).toMatchObject({ kind: 'ready', tag: { scope: 'user', count: 1 } });
    expect(resolved.card).toMatchObject({ passId: user.pass.id });
  });

  it('refuses admission at /resolve and /actions when a new release raises the minimum', async () => {
    const s = await f.desk({ templateIds: [f.tpl] });
    const { pass, card } = await f.pass();
    const tag = f.read();
    expect((await f.bind(s, { card, tag })).status).toBe(200);
    expect(await post(s, '/resolve', tagInput(tag))).toMatchObject({ kind: 'ready' });
    await run(f.kit.env.DB, 'DROP TRIGGER template_versions_immutable');
    await run(
      f.kit.env.DB,
      'UPDATE template_versions SET manifest = json_set(manifest, \'$.scan.tags\', json(\'{"min":"secure"}\')) WHERE template_id = ?',
      [f.tpl],
    );
    const refused = { kind: 'refused', reason: 'tag_not_allowed' };
    expect(await post(s, '/resolve', tagInput(tag))).toMatchObject(refused);
    expect(await post(s, '/actions', tagInput(tag))).toMatchObject(refused);
    expect(await post(s, '/actions', tagInput(tag, { passId: pass.id }))).toMatchObject(refused);
  });
});
