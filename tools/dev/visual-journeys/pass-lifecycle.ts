// One pass followed through every surface: designer, issue, email, hosted page, portal, update, void, remove.
import type { Journey } from '../lib/journey.ts';
import { issue, mailOrSkip, page, passOf, templateByName, tokenOf } from './kit.ts';

const HOLDER = 'maya.chen@example.com';
const hasToken = (env: { vars: Record<string, string> }) => env.vars.token as string;

export const passLifecycle: Journey = {
  name: 'pass-lifecycle',
  title: 'Pass lifecycle',
  org: 'northwind',
  steps: [
    {
      title: 'Template in the console',
      async run(env) {
        const t = await templateByName(env, 'Northwind Member');
        env.vars.templateId = t.id;
        return page('org', `/admin/templates/${t.id}`);
      },
    },
    {
      title: 'Template designer',
      async run(env) {
        return page('org', `/admin/templates/${env.vars.templateId}/design`);
      },
    },
    {
      title: 'New pass: choose a template',
      async run() {
        return page('org', '/admin/passes/new');
      },
    },
    {
      title: 'Issue the pass with an email',
      async run(env) {
        env.vars.since = String(Date.now() - 2_000);
        const pass = await issue(
          env,
          env.vars.templateId as string,
          {
            holder: 'Maya Chen',
            memberId: `JRN-${env.stamp}`,
            tier: 'Plus',
            note: 'Welcome aboard.',
          },
          { holderEmail: HOLDER, sendEmail: true, key: 'life' },
        );
        env.vars.passId = pass.id;
        env.vars.token = tokenOf(pass.publicUrl);
        return page('org', `/admin/passes/${pass.id}`);
      },
    },
    {
      title: 'Delivery email',
      async run(env) {
        const token = hasToken(env);
        const mail = await env.mail(
          Number(env.vars.since),
          (m) => m.html.includes(token) || m.text.includes(token),
        );
        return mailOrSkip(mail, 'delivery');
      },
    },
    { title: 'Hosted page', run: async (env) => page('anon', `/p/${hasToken(env)}`) },
    { title: 'Portal list', run: async () => page('holder', '/') },
    { title: 'Portal pass', run: async (env) => page('holder', `/passes/${env.vars.passId}`) },
    {
      title: 'Admin edits a field and publishes',
      async run(env) {
        const org = await env.api('org');
        const pass = await passOf(org, env, env.vars.passId as string);
        await org.patch(
          `/api/v1/passes/${pass.id}?orgId=${env.orgId}`,
          {
            input: { ...pass.personalization, tier: 'Pro', note: 'Upgraded to Pro.' },
            notify: true,
          },
          { 'if-match': String(pass.version) },
        );
        return page('org', `/admin/passes/${pass.id}`);
      },
    },
    {
      title: 'Hosted page after the update',
      run: async (env) => page('anon', `/p/${hasToken(env)}`),
    },
    {
      title: 'Portal pass after the update',
      run: async (env) => page('holder', `/passes/${env.vars.passId}`),
    },
    {
      title: 'Void',
      async run(env) {
        const org = await env.api('org');
        await org.post(`/api/v1/passes/${env.vars.passId}/void?orgId=${env.orgId}`);
        return page('org', `/admin/passes/${env.vars.passId}`);
      },
    },
    { title: 'Hosted page after void', run: async (env) => page('anon', `/p/${hasToken(env)}`) },
    {
      title: 'Portal pass after void',
      run: async (env) => page('holder', `/passes/${env.vars.passId}`),
    },
    {
      title: 'Remove from Wallet',
      async run(env) {
        const org = await env.api('org');
        await org.post(`/api/v1/passes/${env.vars.passId}/remove?orgId=${env.orgId}`, {
          message: 'This pass was cancelled.',
        });
        return page('org', `/admin/passes/${env.vars.passId}`);
      },
    },
    { title: 'Hosted page after remove', run: async (env) => page('anon', `/p/${hasToken(env)}`) },
  ],
};
