import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import { confirmPage, expiredPage } from '../modules/auth/pages.ts';
import { voidPass } from '../modules/passes/service.ts';
import { type Kit, setupKit } from '../modules/passes/test-kit.ts';
import type { AppBindings } from '../platform/context.ts';
import { ROBOTS, securityHeaders } from '../platform/security-headers.ts';
import { renderErrorPage } from './error-page.tsx';
import { APP_DESCRIPTION } from './head.ts';
import { escapeHtml } from './theme.ts';

const ORIGIN = 'https://wallet.test';
const metas = (html: string) => (html.match(/<meta [^>]*>/g) ?? []).join('\n');
const content = (html: string, key: string) =>
  new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html)?.[1];

describe('auth and error page heads', () => {
  const confirm = confirmPage('n', {
    token: 't'.repeat(20),
    email: 'ada@example.com',
    purpose: 'sign_in',
  });

  it.each([
    ['confirm', confirm, 'Sign in'],
    ['expired', expiredPage('n'), 'Link expired'],
    ['404', renderErrorPage({ status: 404, nonce: 'n' }), 'Page not found'],
  ])('%s: noindex, the app manifest, a generic preview and the title pattern', (_, html, title) => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(content(html, 'og:title')).toBe(title);
    expect(content(html, 'og:description')).toBe(APP_DESCRIPTION);
    expect(content(html, 'description')).toBe(APP_DESCRIPTION);
    expect(content(html, 'apple-mobile-web-app-title')).toBe('PassBook');
    expect(html).toContain(`<title>${title} · PassBook</title>`);
  });

  it('keeps the email in the body, out of the head', () => {
    expect(confirm).toContain('ada@example.com');
    const head = /<head>([\s\S]*)<\/head>/.exec(confirm)?.[1] ?? '';
    expect(head).not.toContain('ada@example.com');
  });
});

describe('pass page head', () => {
  let kit: Kit;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    kit = await setupKit();
    app = createApp({ stores: fakeAuth(ORIGIN).stores });
  });
  const page = async (token: string) =>
    (await app.request(`${ORIGIN}/p/${token}`, {}, kit.env)).text();

  it('previews the org and the state, never the holder or a pass field', async () => {
    const pass = await kit.pass({ memberName: 'Zed Quill', holderEmail: 'zed@holder.test' });
    const html = await page(pass.downloadToken);
    expect(html).toContain('Zed Quill');
    const tags = metas(html);
    expect(tags).not.toMatch(/Zed|Quill|holder\.test/);
    expect(tags).not.toContain(pass.downloadToken);
    const org = escapeHtml(kit.org.name);
    expect(content(html, 'og:title')).toBe(`${org} pass`);
    expect(content(html, 'og:description')).toBe('Add it to Apple Wallet.');
    expect(content(html, 'description')).toBe('Add it to Apple Wallet.');
    expect(content(html, 'apple-mobile-web-app-title')).toBe(org);
    expect(tags).not.toMatch(/og:image|og:url/);
    // A pass saved to the home screen opens itself, not the portal.
    expect(html).not.toContain('rel="manifest"');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
  });

  it('previews a voided pass as voided', async () => {
    const pass = await kit.pass();
    await voidPass(kit.ctx, { type: 'user', id: 'admin-1' }, pass.id, null);
    const html = await page(pass.downloadToken);
    expect(content(html, 'og:description')).toBe('This pass was voided.');
  });
});

describe('X-Robots-Tag', () => {
  let kit: Kit;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    kit = await setupKit();
    app = createApp({ stores: fakeAuth(ORIGIN).stores });
  });

  it.each(['/auth/magic?token=nope', '/p/abcdefghijklmnopqrst', '/api/v1/session', '/health'])(
    '%s is noindex, nofollow',
    async (path) => {
      const res = await app.request(
        `${ORIGIN}${path}`,
        { headers: { accept: 'text/html' } },
        kit.env,
      );
      await res.arrayBuffer();
      expect(res.headers.get('x-robots-tag')).toBe(ROBOTS);
    },
  );

  it('leaves the hashed bundles alone', async () => {
    const mini = new Hono<AppBindings>();
    mini.use('*', securityHeaders);
    mini.get('*', (c) => c.text('ok'));
    expect((await mini.request('/assets/index-abc.js')).headers.get('x-robots-tag')).toBeNull();
    expect((await mini.request('/elsewhere')).headers.get('x-robots-tag')).toBe(ROBOTS);
  });
});
