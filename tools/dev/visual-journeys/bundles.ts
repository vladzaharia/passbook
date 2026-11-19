// A bundle of passes from the console to the holder: the passes, the email, the page, Add all.
import type { Journey } from '../lib/journey.ts';
import { issue, type Json, mailOrSkip, page, templateByName, tokenOf } from './kit.ts';

export const bundles: Journey = {
  name: 'bundles',
  title: 'Bundles',
  org: 'northwind',
  steps: [
    {
      title: 'Two passes for one holder',
      async run(env) {
        const t = await templateByName(env, 'Northwind Member');
        const make = async (n: number) =>
          issue(
            env,
            t.id,
            {
              holder: 'Maya Chen',
              memberId: `JRN-B${n}-${env.stamp}`,
              tier: n === 1 ? 'Plus' : 'Pro',
            },
            { holderEmail: 'maya.chen@example.com', key: `bundle${n}` },
          );
        const [a, b] = [await make(1), await make(2)];
        env.vars.passIds = `${a.id},${b.id}`;
        return page('org', `/admin/passes/${a.id}`);
      },
    },
    {
      title: 'Bundle created and emailed',
      async run(env) {
        const owner = await env.api('org');
        env.vars.since = String(Date.now() - 1_000);
        const bundle: Json = await owner.post('/api/v1/bundles', {
          orgId: env.orgId,
          name: `Journey bundle ${env.stamp}`,
          passIds: (env.vars.passIds as string).split(','),
          holderEmail: 'maya.chen@example.com',
          sendEmail: true,
        });
        env.vars.token = tokenOf(bundle.url ?? '');
        env.vars.bundleId = bundle.id;
        return page('org', '/admin/passes');
      },
    },
    {
      title: 'Bundle email',
      async run(env) {
        const token = env.vars.token as string;
        if (!token) return { skip: 'the bundle has no link' };
        return mailOrSkip(
          await env.mail(
            Number(env.vars.since),
            (m) => m.html.includes(token) || m.text.includes(token),
          ),
          'bundle',
        );
      },
    },
    {
      title: 'Bundle page',
      async run(env) {
        if (!env.vars.token) return { skip: 'the bundle has no link' };
        return page('anon', `/b/${env.vars.token}`);
      },
    },
    {
      title: 'Add all',
      async run(env) {
        if (!env.vars.token) return { skip: 'the bundle has no link' };
        return page('anon', `/b/${env.vars.token}`, {
          prepare: async (p) => {
            // Hovering shows the control's state; the download itself is not followed.
            await p
              .getByRole('link', { name: /add to apple wallet/i })
              .first()
              .hover();
          },
        });
      },
    },
    {
      title: 'Bundle page after a pass is voided',
      async run(env) {
        if (!env.vars.token) return { skip: 'the bundle has no link' };
        const owner = await env.api('org');
        const first = (env.vars.passIds as string).split(',')[0];
        await owner.post(`/api/v1/passes/${first}/void?orgId=${env.orgId}`);
        return page('anon', `/b/${env.vars.token}`);
      },
    },
  ],
};
