// Retention: the settings an operator and an org admin see, a change, and where it is recorded.
import type { Journey } from '../lib/journey.ts';
import { type Json, page } from './kit.ts';

export const retention: Journey = {
  name: 'retention',
  title: 'Retention',
  org: 'northwind',
  steps: [
    { title: 'Platform retention settings', run: async () => page('platform', '/admin/settings') },
    { title: 'Org retention settings', run: async () => page('org', '/admin/settings') },
    {
      title: 'Org changes a retention window',
      async run(env) {
        const owner = await env.api('org');
        const scope = `org:${env.orgId}`;
        const list: Json = await owner.get(`/api/v1/settings?scope=${encodeURIComponent(scope)}`);
        const current = list.items.find((s: Json) => s.key === 'retention.scansDays')?.value;
        // Alternates between two values so a rerun always records a real change.
        await owner.put('/api/v1/settings', {
          scope,
          values: { 'retention.scansDays': current === 400 ? 365 : 400 },
          ...(list.configRevision === undefined ? {} : { configRevision: list.configRevision }),
        });
        return page('org', '/admin/settings');
      },
    },
    { title: 'Org audit log', run: async () => page('org', '/admin/audit') },
    { title: 'Platform audit log', run: async () => page('platform', '/admin/audit') },
    {
      title: 'Legal hold placed',
      run: async () => ({
        skip: 'holds have a service (placeHold) and an email, but no HTTP route or console screen yet',
      }),
    },
    {
      title: 'Legal hold released',
      run: async () => ({ skip: 'same: no route or screen to release a hold' }),
    },
    {
      title: 'Receipts',
      run: async () => ({
        skip: 'retention receipts are stored and verified server-side; nothing lists them in the console or API',
      }),
    },
  ],
};
