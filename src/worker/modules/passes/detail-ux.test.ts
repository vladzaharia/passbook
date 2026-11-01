import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import {
  BulkPassActionResponseSchema,
  PassDetailSchema,
  PassListSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { enqueuePush } from '../delivery/service.ts';
import { getPass } from './repo.ts';
import { ICON_PNG, type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

const api = (path: string, init: RequestInit = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const post = (path: string, body: unknown, headers = fake.admin()) =>
  api(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const detail = async (id: string) =>
  PassDetailSchema.parse(await (await api(`/passes/${id}`, { headers: fake.admin() })).json());

describe('detail after a refresh', () => {
  it('parses with the contract once the outbox holds a push row', async () => {
    const pass = await kit.pass();
    expect((await post(`/passes/${pass.id}/refresh`, {})).status).toBe(202);
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await kit.settle();
    const res = await api(`/passes/${pass.id}`, { headers: fake.admin() });
    const parsed = PassDetailSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.deliveries[0]?.id).toMatch(/^push:.+:refresh:/);
    expect(parsed.data?.deliveries[0]?.id.length).toBeGreaterThan(64);
  });
});

describe('devices', () => {
  it('counts devices in the list, filters by them and lists them on the detail', async () => {
    const on = await kit.pass({ memberName: 'On Device' });
    const off = await kit.pass({ memberName: 'Off Device' });
    await kit.device(on, 'device-library-abc123', 'token-1');
    const list = async (q: string) =>
      PassListSchema.parse(
        await (await api(`/passes?limit=200&${q}`, { headers: fake.admin() })).json(),
      ).items;
    const all1 = await list('');
    expect(all1.find((p) => p.id === on.id)?.deviceCount).toBe(1);
    expect(all1.find((p) => p.id === off.id)?.deviceCount).toBe(0);
    const yes = (await list('onDevice=true')).map((p) => p.id);
    const no = (await list('onDevice=false')).map((p) => p.id);
    expect(yes).toContain(on.id);
    expect(yes).not.toContain(off.id);
    expect(no).toContain(off.id);
    expect(no).not.toContain(on.id);
    const d = await detail(on.id);
    expect(d.registrations).toBe(1);
    expect(d.devices).toEqual([
      { shortId: 'abc123', createdAt: expect.any(Number), lastPush: null },
    ]);
    expect(JSON.stringify(d)).not.toContain('device-library');
  });
});

describe('bulk actions', () => {
  it('voids exactly the selected passes, each audited', async () => {
    const picked = await Promise.all([1, 2, 3].map((n) => kit.pass({ memberName: `Bulk ${n}` })));
    const other = await kit.pass({ memberName: 'Untouched' });
    const res = await post('/passes/bulk', {
      action: 'void',
      ids: picked.map((p) => p.id),
      orgId: kit.org.id,
    });
    expect(res.status).toBe(200);
    expect(BulkPassActionResponseSchema.parse(await res.json())).toEqual({ done: 3, skipped: [] });
    for (const p of picked) expect((await getPass(kit.env.DB, p.id))?.status).toBe('voided');
    expect((await getPass(kit.env.DB, other.id))?.status).toBe('active');
    const audits = await all<{ target_id: string }>(
      kit.env.DB,
      "SELECT target_id FROM audit_log WHERE action = 'pass.void' AND target_id IN (?, ?, ?)",
      picked.map((p) => p.id),
    );
    expect(audits).toHaveLength(3);
    const voided = await detail(picked[0]?.id ?? '');
    expect(voided.voided).toMatchObject({ at: expect.any(Number), actorType: 'user' });
  });

  it('rejects ids from another org and changes nothing', async () => {
    const orgB = await makeOrg(kit.fx, { name: 'Other Org' });
    const mine = await kit.pass({ memberName: 'Mine' });
    const theirs = await kit.pass({ memberName: 'Theirs', orgId: orgB.id });
    const ids = [mine.id, theirs.id];
    const scopedKey = fake.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    expect((await post('/passes/bulk', { action: 'void', ids }, scopedKey)).status).toBe(404);
    expect((await post('/passes/bulk', { action: 'void', ids, orgId: kit.org.id })).status).toBe(
      404,
    );
    expect((await getPass(kit.env.DB, mine.id))?.status).toBe('active');
    expect((await getPass(kit.env.DB, theirs.id))?.status).toBe('active');
  });

  it('emails holders and skips passes without one; caps the selection at 100', async () => {
    const withHolder = await kit.pass({ holderEmail: 'bulk@example.com' });
    const without = await kit.pass();
    const res = await post('/passes/bulk', {
      action: 'send_email',
      ids: [withHolder.id, without.id],
    });
    expect(BulkPassActionResponseSchema.parse(await res.json())).toEqual({
      done: 1,
      skipped: [{ id: without.id, code: 'NO_RECIPIENT' }],
    });
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect((await post('/passes/bulk', { action: 'void', ids: many })).status).toBe(422);
  });
});

describe('change messages', () => {
  it('adds them only with Notify holders, only for changed fields', async () => {
    const resolved = kit.registry.add({
      id: 'tpl-notify',
      orgId: null,
      version: 'v1',
      manifest: {
        ...kit.template.manifest,
        inputs: {
          type: 'object',
          required: ['memberName'],
          properties: { memberName: { type: 'string' }, message: { type: 'string' } },
        },
        bindings: [
          { to: { field: 'name' }, value: '{{memberName}}' },
          { to: { field: 'note' }, value: '{{message}}' },
        ],
      },
      passJson: {
        ...kit.template.passJson,
        generic: {
          primaryFields: [{ key: 'name', label: 'Member', value: '', changeMessage: 'Now %@' }],
          backFields: [{ key: 'note', label: 'Message', value: '', changeMessage: '%@' }],
        },
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, resolved);
    const created = await post('/passes', {
      orgId: kit.org.id,
      templateId: 'tpl-notify',
      input: { memberName: 'Ana', message: 'Hello' },
    });
    const id = ((await created.json()) as { id: string }).id;
    const patch = async (input: Record<string, unknown>, notify?: boolean) => {
      const current = await detail(id);
      const res = await api(`/passes/${id}`, {
        method: 'PATCH',
        headers: {
          ...fake.admin(),
          'content-type': 'application/json',
          'if-match': `"${current.version}"`,
        },
        body: JSON.stringify({ input, ...(notify === undefined ? {} : { notify }) }),
      });
      expect(res.status).toBe(200);
      return PassDetailSchema.parse(await res.json()).passJson as {
        generic: {
          primaryFields: { changeMessage?: string }[];
          backFields: { changeMessage?: string }[];
        };
      };
    };
    const quiet = await patch({ message: 'Doors at 7' });
    expect(JSON.stringify(quiet)).not.toContain('changeMessage');
    const loud = await patch({ memberName: 'Ana B' }, true);
    expect(loud.generic.primaryFields[0]?.changeMessage).toBe('Now %@');
    expect(loud.generic.backFields[0]?.changeMessage).toBeUndefined();
  });
});

describe('tenant identity', () => {
  it('names the org, warns on starter art and downloads under the org and title', async () => {
    const resolved = kit.registry.add({
      id: 'baked:starter-tenant',
      orgId: null,
      version: 'v1',
      manifest: kit.template.manifest,
      passJson: { ...kit.template.passJson, logoText: 'Wallet', description: 'Wallet store card' },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, resolved);
    const create = async () =>
      PassDetailSchema.parse(
        await (
          await post('/passes', {
            orgId: kit.org.id,
            templateId: resolved.id,
            input: { memberName: 'Maya Chen' },
          })
        ).json(),
      );
    const plain = await create();
    expect(plain.passJson).toMatchObject({
      logoText: kit.org.name,
      description: `${kit.org.name} store card`,
    });
    expect(plain.warnings.map((w) => w.code)).toContain('PLATFORM_BRANDING');

    const sha1 = await sha1Hex(ICON_PNG);
    const image = (key: string) => ({ key, sha1, size: ICON_PNG.length, width: 38, height: 38 });
    await run(kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({
        logoHasName: true,
        passColors: { background: 'rgb(10, 20, 30)', foreground: 'rgb(250, 250, 250)' },
        images: {
          'icon.png': image('org-assets/icon.png'),
          'logo.png': image('org-assets/logo.png'),
        },
      }),
      kit.org.id,
    ]);
    await kit.env.BUCKET.put('org-assets/icon.png', ICON_PNG);
    await kit.env.BUCKET.put('org-assets/logo.png', ICON_PNG);
    const branded = await create();
    expect(branded.passJson.logoText).toBeUndefined();
    expect(branded.passJson.backgroundColor).toBe('rgb(10, 20, 30)');
    expect(branded.warnings.map((w) => w.code)).not.toContain('PLATFORM_BRANDING');

    const res = await app.request(new URL(branded.downloadUrl).pathname, {}, kit.env);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${kit.org.slug}-maya-chen.pkpass"`,
    );
  });
});
