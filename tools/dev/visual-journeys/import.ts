// A sheet to passes: upload, column mapping, check with one bad row, commit, results, the passes made.
import type { Journey } from '../lib/journey.ts';
import { type Json, page, templateByName } from './kit.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const importJourney: Journey = {
  name: 'import',
  title: 'Import passes from a CSV',
  org: 'northwind',
  steps: [
    {
      title: 'Import page',
      async run(env) {
        env.vars.templateId = (await templateByName(env, 'Northwind Member')).id;
        return page('org', '/admin/passes/import');
      },
    },
    {
      title: 'Columns after upload',
      async run(env) {
        const owner = await env.api('org');
        const s = env.stamp;
        // Row 3 has a tier the template does not allow: the check reports it.
        const csv = [
          'Name,Member ID,Tier,Email,External ID',
          `Ada Lovelace,J-1,Plus,journey.ada.${s}@example.com,jx-${s}-1`,
          `Bob Byte,J-2,Platinum,journey.bob.${s}@example.com,jx-${s}-2`,
          `Cy Code,J-3,Pro,journey.cy.${s}@example.com,jx-${s}-3`,
        ].join('\n');
        const imp: Json = await owner.post(`/api/v1/pass-imports?orgId=${env.orgId}`, {
          templateId: env.vars.templateId,
          source: { kind: 'file', name: `members-${s}.csv`, csv },
        });
        env.vars.importId = imp.id;
        return page('org', `/admin/passes/import/${imp.id}`);
      },
    },
    {
      title: 'Check with one invalid row',
      async run(env) {
        const owner = await env.api('org');
        const q = `/api/v1/pass-imports/${env.vars.importId}`;
        await owner.post(`${q}/check?orgId=${env.orgId}`, {
          plan: {
            mapping: {
              holder: { from: '/Name' },
              memberId: { from: '/Member ID' },
              tier: { from: '/Tier' },
            },
            holderEmail: { from: '/Email' },
            externalId: { from: '/External ID' },
            match: 'externalId',
            keepManual: false,
            save: false,
          },
        });
        for (let i = 0; i < 30; i++) {
          const imp: Json = await owner.get(`${q}?orgId=${env.orgId}`);
          if (imp.state !== 'checking') break;
          await wait(1000);
        }
        return page('org', `/admin/passes/import/${env.vars.importId}`);
      },
    },
    {
      title: 'Results',
      async run(env) {
        const owner = await env.api('org');
        const q = `/api/v1/pass-imports/${env.vars.importId}`;
        await owner.post(`${q}/commit?orgId=${env.orgId}`, { skipInvalid: true, email: false });
        let imp: Json = {};
        for (let i = 0; i < 60; i++) {
          imp = await owner.get(`${q}?orgId=${env.orgId}`);
          if (['done', 'failed'].includes(imp.state)) break;
          await wait(1000);
        }
        if (imp.state !== 'done') throw new Error(`Import ended ${imp.state}.`);
        const rows = await owner.get(`${q}/rows?orgId=${env.orgId}&state=done`);
        env.vars.passId = rows.items.find((r: Json) => r.passId)?.passId ?? '';
        return page('org', `/admin/passes/import/${env.vars.importId}`);
      },
    },
    {
      title: 'Passes list',
      run: async (env) => page('org', `/admin/passes?orgId=${env.orgId}`),
    },
    {
      title: 'A pass the import made',
      async run(env) {
        if (!env.vars.passId) return { skip: 'no pass was created' };
        return page('org', `/admin/passes/${env.vars.passId}`);
      },
    },
  ],
};
