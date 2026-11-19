import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  BASE,
  type Link,
  type PublicKit,
  publicKit,
  turnstile,
  verdictOf,
} from './public-test-fixtures.ts';

let t: PublicKit;
beforeAll(async () => {
  t = await publicKit();
}, 120_000);
afterAll(() => t.restore());
beforeEach(async () => {
  await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
  turnstile.verdict = verdictOf();
  turnstile.asked.length = 0;
});

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0';

const open = (l: Link, ua = IPHONE_SAFARI, key = '') =>
  t.app.request(
    `${BASE}/j/${l.token}`,
    { headers: { 'cf-connecting-ip': '203.0.113.5', 'user-agent': ua } },
    { ...t.kit.env, TURNSTILE_SITE_KEY: key },
  );

describe('GET /j/:token: the join page', () => {
  it('draws the card with defaults only, and holds no pass, link or code', async () => {
    const l = await t.link({ askEmail: false });
    const res = await open(l);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('pc-stage');
    expect(html).toContain('data-buddy');
    expect(html).not.toContain('/p/');
    expect(html).not.toContain('pkpass');
    expect(html).not.toContain('pc-barcode');
    expect(html).not.toMatch(/PREVIEW2PASS/);
  });

  it('answers with the nonce, the Turnstile policy, no referrer and no store', async () => {
    const res = await open(await t.link());
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(csp).toContain('https://challenges.cloudflare.com');
    expect(html).toContain('<script src="/join.js" defer></script>');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('lets the form post carry its origin, and keeps the token out of every Referer', async () => {
    const l = await t.link({ askEmail: false });
    const res = await open(l);
    const html = await res.text();
    const policies = [
      res.headers.get('referrer-policy'),
      /<meta name="referrer" content="([^"]+)"/.exec(html)?.[1],
    ];
    // Fetch spec: a POST from a no-referrer page carries `Origin: null`; any other policy sends the origin.
    for (const policy of policies) expect(policy).not.toBe('no-referrer');
    // Neither policy sends a path, so the token in the URL never leaves the page.
    for (const policy of policies) expect(policy).toBe('strict-origin');
    const post = (origin: string) =>
      t.app.request(
        `${BASE}/j/${l.token}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cf-connecting-ip': '203.0.113.7',
            origin,
          },
          body: 'name=Sam&cf-turnstile-response=tok',
        },
        t.kit.env,
      );
    expect((await post(BASE)).status).toBe(303);
    // The origin check still refuses what a no-referrer page would have sent.
    expect((await post('null')).status).toBe(403);
  });

  it('hands the public site key to the script only when one is set', async () => {
    const l = await t.link();
    expect(await (await open(l, IPHONE_SAFARI, '0x4AAAAAAAkey')).text()).toContain(
      'data-sitekey="0x4AAAAAAAkey"',
    );
    expect(await (await open(l)).text()).not.toContain('data-sitekey');
  });

  it('says to open Safari, with Copy link, in an app web view and nowhere else', async () => {
    const l = await t.link();
    const app = await (await open(l, INSTAGRAM)).text();
    expect(app).toContain('Open in Safari to add to Apple Wallet.');
    expect(app).toContain('data-copy=""');
    expect(await (await open(l, IPHONE_SAFARI)).text()).not.toContain('Open in Safari');
  });

  it('shows the test strip on a test link only', async () => {
    const test = await (await open(await t.link({ mode: 'test' }))).text();
    expect(test).toContain('Test card. It is not real and will be deleted.');
    expect(test).toContain('pc-stage');
    expect(await (await open(await t.link())).text()).not.toContain('Test card.');
  });

  it('re-renders a refused form with its card and the one-sentence error', async () => {
    const l = await t.link({ askEmail: false });
    const res = await t.post(l, { name: '' });
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain('role="alert"');
    expect(html).toContain('pc-stage');
    turnstile.verdict = verdictOf({ success: false });
    const failed = await t.post(l, { name: 'Sam' });
    expect(failed.status).toBe(403);
    expect(await failed.text()).toContain('Verification failed. Try again.');
  });
});

describe('GET /j/:token/card/:name: the card images', () => {
  const image = (l: Link, name: string, token = l.token) =>
    t.app.request(
      `${BASE}/j/${token}/card/${name}`,
      { headers: { 'cf-connecting-ip': '203.0.113.5' } },
      t.kit.env,
    );

  it("serves the open release's images, and nothing else", async () => {
    const l = await t.link();
    const ok = await image(l, 'icon.png');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toContain('private');
    expect((await image(l, 'ghost.png')).status).toBe(404);
    expect((await image(l, '..%2Fpass.json')).status).toBe(404);
    expect((await image(l, 'icon.svg')).status).toBe(404);
  });

  it('is 404 for an unknown or switched-off link', async () => {
    const l = await t.link();
    expect((await image(l, 'icon.png', 'A'.repeat(22))).status).toBe(404);
    const off = await t.link({ enabled: false });
    expect((await image(off, 'icon.png')).status).toBe(404);
  });
});
