import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { all } from '../../platform/db.ts';
import { basicPackage, makePng, passJson, zipOf } from '../templates/package/fixtures.ts';
import { importZip } from '../templates/testing.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

/** A stamps template's own PNGs: the card art and the logo and icon sizes (the strips are generated per count). */
const FILES = [
  'stamps/filled.png',
  'stamps/empty.png',
  'stamps/reward.png',
  'stamps/reward-earned.png',
  'logo@2x.png',
  'logo@3x.png',
  'icon@3x.png',
];

const manifest = {
  schema: 1,
  name: 'Stamps',
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};

async function stampsTemplate(orgId: string, userId: string) {
  const size: Record<string, [number, number]> = {
    'icon@3x.png': [114, 114],
    'logo@2x.png': [200, 60],
    'logo@3x.png': [300, 90],
  };
  const imported = await importZip(t.kit.env, t.kit.clock, {
    orgId,
    createdBy: userId,
    name: 'Stamps',
    zip: zipOf(
      basicPackage(
        {
          'wallet.template.json': JSON.stringify(manifest),
          ...Object.fromEntries(FILES.map((name) => [name, makePng(...(size[name] ?? [8, 8]))])),
        },
        passJson(),
      ),
    ),
  });
  if (!imported.result)
    throw new Error(
      `Import stopped at ${imported.stages.at(-1)} ${JSON.stringify(await all(t.kit.env.DB, 'SELECT error, report FROM template_imports WHERE upload_id = ?', [imported.p.uploadId])).slice(0, 1500)}`,
    );
  return imported.result;
}

const never = { limit: async () => ({ success: false }) } as unknown as RateLimit;

describe('file reads on the Workbench token', () => {
  it('load a stamps template well past the try budget, and leave it whole', async () => {
    const m = await t.member();
    const { templateId, version } = await stampsTemplate(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const asset = (name: string) =>
      t.call(
        'GET',
        `/templates/${templateId}/versions/${version}/assets/${encodeURIComponent(name)}?orgId=${m.orgId}`,
        t.asClient(token),
      );
    // The card, the images list, the strip preview and every re-render ask again: 70 reads, over RL_API_TRY's 60.
    for (let pass = 0; pass < 10; pass++)
      for (const name of FILES) {
        const res = await asset(name);
        expect(res.status, `${name} pass ${pass}`).toBe(200);
        await res.arrayBuffer();
      }
    // The session's own budget is untouched: a call that is not a file read still goes through.
    const template = await t.call(
      'GET',
      `/templates/${templateId}?orgId=${m.orgId}`,
      t.asClient(token),
    );
    expect(template.status, await template.clone().text()).toBe(200);
  });

  it('keep their own budget: neither bucket spends the other', async () => {
    const m = await t.member();
    const { templateId, version } = await stampsTemplate(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const asset = () =>
      t.call(
        'GET',
        `/templates/${templateId}/versions/${version}/assets/${encodeURIComponent(FILES[0] ?? '')}?orgId=${m.orgId}`,
        t.asClient(token),
      );
    const detail = () =>
      t.call('GET', `/templates/${templateId}?orgId=${m.orgId}`, t.asClient(token));
    const env = t.kit.env;
    const saved = { try: env.RL_API_TRY, asset: env.RL_API_TRY_ASSET };
    try {
      env.RL_API_TRY = never;
      expect((await asset()).status).toBe(200);
      expect((await detail()).status).toBe(429);
      env.RL_API_TRY = saved.try;
      env.RL_API_TRY_ASSET = never;
      expect((await asset()).status).toBe(429);
      expect((await detail()).status).toBe(200);
    } finally {
      env.RL_API_TRY = saved.try;
      env.RL_API_TRY_ASSET = saved.asset;
    }
  });
});
