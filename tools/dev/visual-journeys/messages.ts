// A message from the composer to what the holder sees; the test inbox in Test mode; automatic messages.
import type { Journey } from '../lib/journey.ts';
import {
  ensureTestRelease,
  issue,
  type Json,
  mailOrSkip,
  page,
  templateByName,
  tokenOf,
} from './kit.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MESSAGE = 'Pool closed Monday for cleaning.';

export const messages: Journey = {
  name: 'messages',
  title: 'Messages',
  org: 'northwind',
  steps: [
    { title: 'Messages list', run: async () => page('org', '/admin/messages') },
    {
      title: 'Composer',
      run: async () =>
        page('org', '/admin/messages/new', {
          prepare: async (p) => {
            await p
              .getByRole('textbox', { name: /message/i })
              .first()
              .fill(MESSAGE);
          },
        }),
    },
    {
      title: 'A pass to message',
      async run(env) {
        const t = await templateByName(env, 'Northwind Member');
        env.vars.templateId = t.id;
        const pass = await issue(
          env,
          t.id,
          { holder: 'Maya Chen', memberId: `JRN-MSG-${env.stamp}`, tier: 'Plus' },
          { holderEmail: 'maya.chen@example.com', key: 'msg' },
        );
        env.vars.passId = pass.id;
        env.vars.token = tokenOf(pass.publicUrl);
        return page('org', `/admin/passes/${pass.id}`);
      },
    },
    {
      title: 'Message sent',
      async run(env) {
        const owner = await env.api('org');
        const made: Json = await owner.post('/api/v1/broadcasts', {
          orgId: env.orgId,
          kind: 'message',
          name: `Journey ${env.stamp}`,
          target: { templateIds: [env.vars.templateId], q: `JRN-MSG-${env.stamp}` },
          patch: { message: MESSAGE },
          notify: true,
          send: 'now',
        });
        for (let i = 0; i < 30; i++) {
          const b: Json = await owner.get(`/api/v1/broadcasts/${made.id}?orgId=${env.orgId}`);
          if (['done', 'failed', 'cancelled'].includes(b.state)) break;
          await wait(1000);
        }
        return page('org', `/admin/messages/${made.id}`);
      },
    },
    {
      title: 'Hosted page with the message',
      run: async (env) => page('anon', `/p/${env.vars.token}`),
    },
    {
      title: 'Portal pass with the message',
      run: async (env) => page('holder', `/passes/${env.vars.passId}`),
    },
    {
      title: 'Message rule (API only)',
      async run(env) {
        const owner = await env.api('org');
        const rules: Json = await owner.get(`/api/v1/message-rules?orgId=${env.orgId}`);
        const name = 'Journey renewal reminder';
        if (!rules.items.some((r: Json) => r.name === name))
          await owner.post('/api/v1/message-rules', {
            orgId: env.orgId,
            name,
            templateIds: [env.vars.templateId],
            anchor: { kind: 'input', input: 'since' },
            offset: { amount: 7, unit: 'day', when: 'before' },
            yearly: true,
            sendAt: '10:00',
            timeZone: 'America/Los_Angeles',
            message: 'Your membership renews in a week.',
            on: false,
          });
        // The console has no rules screen yet; the messages list is where a rule's sends would show.
        return page('org', '/admin/messages');
      },
    },
    {
      title: 'Test inbox before',
      run: async () => page('org', '/admin/test-inbox', { mode: 'test' }),
    },
    {
      title: 'Test-mode pass emailed',
      async run(env) {
        await ensureTestRelease(env, env.vars.templateId as string);
        const pass = await issue(
          env,
          env.vars.templateId as string,
          { holder: 'Test Holder', memberId: `JRN-TST-${env.stamp}` },
          {
            holderEmail: `journey.test.${env.stamp}@example.com`,
            sendEmail: true,
            key: 'tst',
            mode: 'test',
          },
        );
        env.vars.testPassId = pass.id;
        return page('org', '/admin/test-inbox', { mode: 'test' });
      },
    },
    {
      title: 'Captured email',
      async run(env) {
        const owner = (await env.api('org')).test;
        let items: Json[] = [];
        for (let i = 0; i < 15 && items.length === 0; i++) {
          items = (await owner.get(`/api/v1/test-inbox?orgId=${env.orgId}`)).items;
          if (items.length === 0) await wait(1000);
        }
        const first = items[0];
        if (!first) return { skip: 'the test inbox stayed empty' };
        const detail: Json = await owner.get(`/api/v1/test-inbox/${first.id}?orgId=${env.orgId}`);
        return mailOrSkip(
          { id: first.id, html: detail.html, text: detail.text, subject: detail.subject, mtime: 0 },
          'captured',
        );
      },
    },
  ],
};
