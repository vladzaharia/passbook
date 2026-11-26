// A new org admin from the invitation to the first screen, then the ways sign-in fails.

import type { Page } from '@playwright/test';
import { request } from '@playwright/test';
import type { Journey } from '../lib/journey.ts';
import { type Json, mailOrSkip, page } from './kit.ts';

const ORG_SLUG = 'journey-onboarding';
const TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';

const emailFace = (email: string) => async (p: Page) => {
  await p.getByRole('textbox', { name: /email/i }).first().fill(email);
  await p
    .getByRole('button', { name: /continue|send|next|sign in|email me/i })
    .first()
    .click();
  await p.waitForLoadState('networkidle').catch(() => undefined);
  // The card cross-fades between its faces.
  await p.waitForTimeout(1_200);
};
let seen = 0;

export const onboardingSignin: Journey = {
  name: 'onboarding-signin',
  title: 'Onboarding and sign-in',
  org: 'northwind',
  steps: [
    {
      title: 'Invite an org admin',
      async run(env) {
        const platform = await env.api('platform');
        const orgs: Json = await platform.get('/api/v1/orgs?limit=100');
        let org = orgs.items.find((o: Json) => o.slug === ORG_SLUG);
        // An empty org, so the first-run checklist shows.
        org ??= await platform.post('/api/v1/orgs', { slug: ORG_SLUG, name: 'Journey Onboarding' });
        env.vars.orgId = org.id;
        env.vars.since = String(Date.now() - 1_000);
        // The mock Polaris ID account `journey-admin` has this address: admins sign in through it.
        env.vars.email = 'journey.admin@example.com';
        try {
          await platform.post(`/api/v1/orgs/${org.id}/invitations`, {
            email: env.vars.email,
            roles: ['org_admin'],
          });
        } catch (error) {
          // A rerun: a pending invitation is sent again; a joined admin gets no new link.
          if (!(error as Error).message.includes('INVITATION_PENDING'))
            console.warn(`invitation skipped: ${(error as Error).message.slice(0, 160)}`);
          else {
            const list: Json = await platform.get(`/api/v1/orgs/${org.id}/invitations?limit=100`);
            const pending = list.items.find((i: Json) => i.email === env.vars.email);
            if (pending)
              await platform.post(`/api/v1/orgs/${org.id}/invitations/${pending.id}/resend`);
          }
        }
        return page('platform', `/admin/orgs/${org.id}`);
      },
    },
    {
      title: 'Invitation email',
      async run(env) {
        const mail = await env.mail(Number(env.vars.since), (m) =>
          m.text.includes('/auth/magic?t='),
        );
        env.vars.token = /\/auth\/magic\?t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1] ?? '';
        return mailOrSkip(mail, 'invitation');
      },
    },
    {
      title: 'Confirm the invitation',
      async run(env) {
        if (!env.vars.token) return { skip: 'no invitation link' };
        return page('anon', `/auth/magic?t=${env.vars.token}`);
      },
    },
    {
      title: 'First org admin landing',
      async run(env) {
        if (!env.vars.token) return { skip: 'no invitation link' };
        // The link accepts the invitation; the console itself needs Polaris ID.
        await env.consume(env.vars.token, `onboard-link-${env.stamp}`);
        const { storage } = await env.signInOidc('journey-admin', `onboard-${env.stamp}`);
        env.vars.storage = storage;
        return page('org', '/admin', { storage, orgId: env.vars.orgId as string });
      },
    },
    {
      title: 'Get started checklist',
      async run(env) {
        if (!env.vars.storage) return { skip: 'the admin never signed in' };
        return page('org', '/admin', {
          storage: env.vars.storage,
          orgId: env.vars.orgId as string,
          waitFor: 'text=Get started',
        });
      },
    },
    { title: 'Sign-in page', run: async () => page('anon', '/login') },
    {
      title: 'Sign-in: check your email',
      // An address no one has: the page answers the same, and no mail is sent.
      run: async (env) =>
        page('anon', '/login', {
          prepare: emailFace(`journey.nobody.${env.stamp}.${seen++}@example.com`),
        }),
    },
    {
      title: 'Sign-in link already used',
      async run(env) {
        if (!env.vars.token) return { skip: 'no used link to show' };
        return page('anon', `/auth/magic?t=${env.vars.token}`);
      },
    },
    {
      title: 'Sign-in link invalid or expired',
      run: async () => page('anon', '/auth/magic?t=expired-journey-link-0000000000'),
    },
    {
      title: 'Sign-in rate limited',
      async run(env) {
        // One throwaway address asks past the 5 an hour cap; nothing is sent for an unknown address.
        const email = `journey.limited.${env.stamp}@example.com`;
        const visitor = await request.newContext({
          baseURL: env.base,
          extraHTTPHeaders: { origin: env.base },
        });
        let last = 0;
        for (let i = 0; i < 7 && last !== 429; i++)
          last = (
            await visitor.post('/auth/magic/request', {
              data: { email, turnstileToken: TURNSTILE },
            })
          ).status();
        await visitor.dispose();
        if (last !== 429) return { skip: 'the request limit never answered 429' };
        return page('anon', '/login', { prepare: emailFace(email) });
      },
    },
    { title: 'Break-glass sign-in page', run: async () => page('anon', '/auth/breakglass') },
  ],
};
