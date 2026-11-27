import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { ReleaseResultSchema } from '../../../shared/contracts/template-releases.ts';
import { all } from '../../platform/db.ts';
import { basicPackage, passJson, zipOf } from '../templates/package/fixtures.ts';
import { importZip } from '../templates/testing.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const manifest = {
  schema: 1,
  name: 'Workbench Flow',
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};

const heads = (templateId: string) =>
  all<{ mode: string; version: string; generation: number }>(
    t.kit.env.DB,
    'SELECT mode, version, generation FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
    [templateId],
  );

describe('L8: release under a token is Test only', () => {
  it('Live in modes gets 403; Test releases; Live release rows are unchanged', async () => {
    const m = await t.member();
    const imported = await importZip(t.kit.env, t.kit.clock, {
      orgId: m.orgId,
      createdBy: m.user.id,
      name: manifest.name,
      zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson())),
    });
    if (!imported.result) throw new Error('Import failed');
    const { templateId, version } = imported.result;
    const { token } = await t.wbMint(m.browser, m.orgId);
    const release = (body: object) =>
      t.call('POST', `/templates/${templateId}/release`, t.asClient(token), { version, ...body });

    for (const modes of [['live'], ['test', 'live']])
      await expectProblem(await release({ modes }), 403, 'WORKBENCH_TEST_ONLY');
    expect(await heads(templateId)).toEqual([]);

    const res = await release({ modes: ['test'] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(Object.keys(ReleaseResultSchema.parse(await res.json()).modes)).toEqual(['test']);
    // Left out, `modes` is Test for a token.
    const again = await release({});
    expect(again.status, await again.clone().text()).toBe(200);
    expect(Object.keys(ReleaseResultSchema.parse(await again.json()).modes)).toEqual(['test']);
    expect((await heads(templateId)).map((h) => h.mode)).toEqual(['test']);
  });
});
