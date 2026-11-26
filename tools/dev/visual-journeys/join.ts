// A join link from setup to a new holder's portal: sign, public page, card, email, sign-up.

import type { Page } from '@playwright/test';
import { request } from '@playwright/test';
import type { Journey } from '../lib/journey.ts';
import { type Json, mailOrSkip, mailView, page, templateByName, tokenOf } from './kit.ts';

const PASS = 'XXXX.DUMMY.TOKEN.XXXX';
/** A sign-in link asked for in one step and used up in a later one, per run. */
const pending = new Map<
  string,
  Awaited<ReturnType<import('../lib/journey-env.ts').JourneyEnv['magic']>>
>();

/** Fills the public form and posts it; the Turnstile widget needs the network, so the hidden field is set directly. */
const submitJoin = (name: string, email: string, base?: string) => async (p: Page) => {
  // A browser sends `Origin: null` from this page (its referrer policy is no-referrer), which the
  // server refuses. With `base`, the header is restored so the rest of the flow can be seen.
  if (base)
    await p.route('**/j/**', async (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            response: await route.fetch({
              headers: { ...route.request().headers(), origin: base },
            }),
          })
        : route.continue(),
    );
  await p.fill('input[name=name]', name);
  await p.fill('input[name=email]', email);
  await p.evaluate((t) => {
    const form = document.querySelector('form.jn-form') as HTMLFormElement;
    (form.elements.namedItem('cf-turnstile-response') as HTMLInputElement).value = t;
    form.submit();
  }, PASS);
  await p.waitForLoadState('load');
};
const fillOnly = (name: string, email: string) => async (p: Page) => {
  await p.fill('input[name=name]', name);
  await p.fill('input[name=email]', email);
};

export const join: Journey = {
  name: 'join',
  title: 'Join link',
  org: 'harbor-lights',
  steps: [
    {
      title: 'Join link setup',
      async run(env) {
        const t = await templateByName(env, 'Harbor Join Badge');
        const owner = await env.api('org');
        const q = `/api/v1/join-links/${t.id}?orgId=${env.orgId}`;
        const state = await owner.get(q);
        const link = (
          await owner.put(q, {
            enabled: true,
            askEmail: true,
            revision: state.link?.revision ?? 0,
          })
        ).link;
        env.vars.templateId = t.id;
        env.vars.joinToken = tokenOf(link.url);
        env.vars.email = `journey.join.${env.stamp}@example.com`;
        return page('org', `/admin/templates/${t.id}`);
      },
    },
    {
      title: 'Printable sign',
      run: async (env) => page('org', `/admin/templates/${env.vars.templateId}/join-sign`),
    },
    { title: 'Public join page', run: async (env) => page('anon', `/j/${env.vars.joinToken}`) },
    {
      title: 'Join form filled in',
      run: async (env) =>
        page('anon', `/j/${env.vars.joinToken}`, {
          prepare: fillOnly('Ada', env.vars.email as string),
        }),
    },
    {
      title: 'Card made',
      async run(env) {
        env.vars.since = String(Date.now() - 1_000);
        const visitor = await request.newContext({
          baseURL: env.base,
          extraHTTPHeaders: { origin: env.base },
        });
        const res = await visitor.post(`/j/${env.vars.joinToken}`, {
          form: { name: 'Ada', email: env.vars.email as string, 'cf-turnstile-response': PASS },
          maxRedirects: 0,
        });
        // With the email asked for, the card goes by mail and the page only says so.
        const html = await res.text();
        await visitor.dispose();
        if (res.status() !== 200 || !html.includes('Check your email'))
          throw new Error(`Join post answered ${res.status()}.`);
        return { kind: 'html', html };
      },
    },
    {
      title: 'Join email',
      async run(env) {
        // The card email is the only mail since the post.
        return mailOrSkip(await env.mail(Number(env.vars.since), () => true), 'join');
      },
    },
    {
      title: 'Join post as a browser sends it',
      run: async (env) =>
        page('anon', `/j/${env.vars.joinToken}`, {
          prepare: submitJoin('Ada', env.vars.email as string),
        }),
    },
    {
      title: 'Same email again',
      run: async (env) =>
        page('anon', `/j/${env.vars.joinToken}`, {
          prepare: submitJoin('Ada', env.vars.email as string, env.base),
        }),
    },
    { title: 'Sign-in page', run: async () => page('anon', '/login') },
    {
      title: 'Sign-in email',
      async run(env) {
        const link = await env.magic(env.vars.email as string, `join-${env.stamp}`);
        env.vars.confirm = link.confirmPath;
        pending.set(env.stamp, link);
        return mailView(link.mail);
      },
    },
    { title: 'Confirm sign-in', run: async (env) => page('anon', env.vars.confirm as string) },
    {
      title: 'Portal after sign-up',
      async run(env) {
        const link = pending.get(env.stamp) as NonNullable<ReturnType<typeof pending.get>>;
        const { storage, api } = await link.finish();
        const mine: Json = await api.get('/api/v1/me/passes?limit=5');
        env.vars.storage = storage;
        env.vars.passId = mine.items[0]?.id ?? '';
        return page('holder', '/', { storage });
      },
    },
    {
      title: 'Portal pass',
      async run(env) {
        if (!env.vars.passId) return { skip: 'the new holder has no pass' };
        return page('holder', `/passes/${env.vars.passId}`, {
          storage: env.vars.storage as string,
        });
      },
    },
  ],
};
