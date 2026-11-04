import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { createPassRow } from '../passes/create.ts';
import { rotateLink, voidPass } from '../passes/service.ts';
import { ICON_PNG, type Kit, setupKit, TINY_PNG } from '../passes/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fakeAuth(ORIGIN).stores });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers }, kit.env);
const actor = { type: 'user', id: 'admin-1' } as const;

describe('GET /p/:token', () => {
  it('renders the pass without script, with a no-JS back toggle and a download link', async () => {
    const pass = await kit.pass();
    // A Mac: the badge sits beside the QR (elsewhere off Apple's devices the scan is the way).
    const res = await get(`/p/${pass.downloadToken}`, {
      'accept-language': 'de-DE,de;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    // The copy is English whatever the visitor's language; the card formats in their locale.
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html).toContain('<meta name="format-detection" content="telephone=no">');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('<meta name="theme-color"');
    expect(html).not.toContain('theme-toggle');
    expect(html).toMatch(
      /<input id="pc-flip" type="radio" class="pc-flip-toggle pc-sr" name="pc-flip"/,
    );
    expect(html).toContain(
      '<label for="pc-flip-front">Front</label><label for="pc-flip">Details</label>',
    );
    expect(html).toContain(`href="/p/${pass.downloadToken}/pass.pkpass"`);
    expect(html).toContain('alt="Add to Apple Wallet"');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it('lists the org support contacts in the footer and drops unsafe ones', async () => {
    const pass = await kit.pass();
    const put = (key: string, value: string) =>
      run(
        kit.env.DB,
        'INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1)',
        [`org:${kit.org.id}`, key, JSON.stringify(value)],
      );
    await put('support.email', 'help@gym.test');
    await put('support.url', 'https://gym.test/help');
    clearSettingsCache(kit.env.DB);
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain('Help: ');
    expect(html).toContain('href="mailto:help@gym.test"');
    expect(html).toContain('href="https://gym.test/help"');
    await put('support.url', 'javascript:alert(1)');
    clearSettingsCache(kit.env.DB);
    const unsafe = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(unsafe).not.toContain('javascript:');
    await run(kit.env.DB, 'DELETE FROM settings WHERE scope = ?', [`org:${kit.org.id}`]);
    clearSettingsCache(kit.env.DB);
    const fallback = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(fallback).toContain('href="mailto:support@passbook.mobile"');
    expect(fallback).not.toContain('gym.test');
  });

  it('sets the privacy headers and a nonce that matches the inline style', async () => {
    const pass = await kit.pass();
    const res = await get(`/p/${pass.downloadToken}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<style nonce="${nonce}">`);
    expect(csp).not.toMatch(/(?:script|style)-src [^;]*unsafe-inline/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('leads with the org, never the platform wordmark', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    // The app shell's bar: 56 px with its border, sticky, on the page surface.
    const head =
      /<header class="sticky top-0 z-20 border-b border-border bg-surface-page[^"]*">(.*?)<\/header>/.exec(
        html,
      )?.[1];
    expect(head).toContain('h-[calc(3.5rem-1px)]');
    expect(head).toContain(kit.org.name);
    expect(html).not.toContain('class="mark"');
  });

  it.each([
    // The iPhone adds right here: the badge, docked.
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', false, true],
    // A Mac adds too, but the scan reaches the phone without iCloud: the QR, the badge beside it
    // (a coarse pointer, an iPad with a Mac agent, hides it in CSS).
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', true, true],
    // Elsewhere the scan is the only way: no badge, so no line about it either.
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1', true, false],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile', true, false],
  ])('follows the shared device rule on %s', async (_name, ua, qr, badge) => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`, { 'user-agent': ua })).text();
    expect(html.includes('Scan with the camera.')).toBe(qr);
    expect(html.includes('alt="Add to Apple Wallet"')).toBe(badge);
    expect(html).not.toContain('Open on iPhone or Mac to add to Apple Wallet.');
  });

  it('asks in-app browsers to open Safari', async () => {
    const pass = await kit.pass();
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148';
    const html = await (await get(`/p/${pass.downloadToken}`, { 'user-agent': ua })).text();
    expect(html).toContain('Open in Safari to add to Apple Wallet.');
  });

  it('leads with a QR of this page for desktop visitors, on the buddy’s sign', async () => {
    const pass = await kit.pass();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
    const html = await (await get(`/p/${pass.downloadToken}`, { 'user-agent': ua })).text();
    const qr = /<img src="(data:image\/svg\+xml;base64,[^"]+)" alt="QR code for ([^"]+)"/.exec(
      html,
    );
    expect(qr?.[2]).toBeTruthy();
    const svg = atob((qr?.[1] ?? '').split(',')[1] ?? '');
    expect(svg).toContain('<svg');
    expect(html).toContain('Scan with the camera.');
    // The scan opens this page on the iPhone, whose badge adds.
    expect(html).toMatch(
      /<div class="wl-sign">[\s\S]*?<span class="wl-sign-qr [^"]*"><img src="data:/,
    );
  });

  it('links the holder to the pass in the portal, quietly, once', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html.match(/<a [^>]*>Open in My passes<\/a>/g)).toEqual([
      expect.stringContaining(`href="/passes/${pass.id}"`),
    ]);
  });

  it('links a voided pass to the org support, once', async () => {
    const pass = await kit.pass();
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1)',
      [`org:${kit.org.id}`, 'support.email', JSON.stringify('help@gym.test')],
    );
    clearSettingsCache(kit.env.DB);
    await voidPass(kit.ctx, actor, pass.id, null);
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    const note = /<div role="status">[\s\S]*?<\/div><\/div><\/div>/.exec(html)?.[0] ?? '';
    expect(note).toContain('This pass was voided.');
    expect(note).toMatch(/href="mailto:help@gym.test"[^>]*>Contact /);
    expect(html.match(/mailto:help@gym.test/g)).toHaveLength(1);
    await run(kit.env.DB, 'DELETE FROM settings WHERE scope = ?', [`org:${kit.org.id}`]);
    clearSettingsCache(kit.env.DB);
  });

  it('shows a voided banner and no download for a voided pass', async () => {
    const pass = await kit.pass();
    await voidPass(kit.ctx, actor, pass.id, null);
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain('This pass was voided.');
    expect(html).not.toContain('Add to Apple Wallet');
    expect(html).not.toContain('QR code');
    // Quiet: a fade in, no deal, glow or tilt (and no tilt script).
    expect(html).toContain('data-enter="quiet"');
    expect(html).not.toContain('data-tilt');
    expect(html).toContain('data-glow="off"');
    expect(html).not.toContain('pass-tilt.js');
  });

  it('shows an expired banner', async () => {
    const { resolved } = makeTemplate({ id: `tpl-exp-${kit.fx.ids.token(4)}` });
    kit.registry.add({
      id: resolved.id,
      version: 'v1',
      manifest: resolved.manifest,
      passJson: { ...resolved.passJson, expirationDate: '2020-01-01T00:00:00Z' },
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, resolved);
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: resolved.id,
      input: { memberName: 'Old' },
      source: 'manual',
      actor,
    });
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain('This pass has expired.');
  });

  it('formats dates in the visitor zone from request.cf, UTC otherwise', async () => {
    const { resolved } = makeTemplate({ id: `tpl-tz-${kit.fx.ids.token(4)}` });
    kit.registry.add({
      id: resolved.id,
      version: 'v1',
      manifest: resolved.manifest,
      passJson: {
        ...resolved.passJson,
        generic: {
          ...(resolved.passJson.generic as object),
          secondaryFields: [
            {
              key: 'when',
              label: 'When',
              value: '2030-06-01T08:00:00Z',
              dateStyle: 'PKDateStyleNone',
              timeStyle: 'PKDateStyleShort',
            },
          ],
        },
      },
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, resolved);
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: resolved.id,
      input: { memberName: 'Zed' },
      source: 'manual',
      actor,
    });
    const url = `${ORIGIN}/p/${pass.downloadToken}`;
    const la = new Request(url, { cf: { timezone: 'America/Los_Angeles' } } as RequestInit);
    expect(await (await app.request(la, {}, kit.env)).text()).toMatch(/1:00\sAM/);
    const bad = new Request(url, { cf: { timezone: 'Not/AZone' } } as RequestInit);
    expect(await (await app.request(bad, {}, kit.env)).text()).toMatch(/8:00\sAM/);
    expect(await (await get(`/p/${pass.downloadToken}`)).text()).toMatch(/8:00\sAM/);
  });

  it('has a heading, and its only inline styles are pass colour variables', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    // The app's 24 px page title.
    expect(html).toMatch(/<h1 [^>]*class="[^"]*text-2xl font-semibold[^"]*">[^<]+<\/h1>/);
    const styles = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(styles.length).toBeGreaterThan(0);
    for (const v of styles)
      expect(v).toMatch(/^(--pc-[a-z]+:rgb\(\d{1,3}, \d{1,3}, \d{1,3}\);?)+$/);
  });

  it('allows unsafe-inline only for style attributes', async () => {
    const pass = await kit.pass();
    const csp =
      (await get(`/p/${pass.downloadToken}`)).headers.get('content-security-policy') ?? '';
    const withInline = csp.split(';').filter((d) => d.includes('unsafe-inline'));
    for (const d of withInline) expect(d.trim()).toMatch(/^style-src-attr /);
  });

  it('answers 404 for unknown, malformed and rotated tokens', async () => {
    const pass = await kit.pass();
    expect((await get('/p/short')).status).toBe(404);
    expect((await get(`/p/${'x'.repeat(43)}`)).status).toBe(404);
    const res = await get(`/p/${'y'.repeat(43)}`);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<h1>Link expired</h1>');
    expect(body).toContain('Sign in to see your passes.');
    expect(body).toContain('class="card" data-state="expired"');
    // The way on is outline, as on every hosted page: My passes, through sign-in when needed.
    expect(body).toMatch(
      /<a class="btn outline" href="\/"><svg[\s\S]*?<\/svg>Go to My passes<\/a>/,
    );
    expect(body).not.toMatch(/class="btn"/);
    await rotateLink(kit.ctx, actor, pass.id, null);
    expect((await get(`/p/${pass.downloadToken}`)).status).toBe(404);
    expect((await get(`/p/${pass.downloadToken}/pass.pkpass`)).status).toBe(404);
  });
});

describe('GET /p/:token/pass.pkpass', () => {
  it('downloads the signed pass with validators and the right MIME type', async () => {
    const pass = await kit.pass();
    const res = await get(`/p/${pass.downloadToken}/pass.pkpass`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('etag')).toBe(`"${pass.objectSha256}"`);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(pass.objectSize);
  });

  it('answers 304 to matching validators', async () => {
    const pass = await kit.pass();
    const first = await get(`/p/${pass.downloadToken}/pass.pkpass`);
    await first.arrayBuffer();
    const etag = first.headers.get('etag') ?? '';
    const lastModified = first.headers.get('last-modified') ?? '';
    expect(
      (await get(`/p/${pass.downloadToken}/pass.pkpass`, { 'if-none-match': etag })).status,
    ).toBe(304);
    expect(
      (await get(`/p/${pass.downloadToken}/pass.pkpass`, { 'if-modified-since': lastModified }))
        .status,
    ).toBe(304);
    expect(
      (await get(`/p/${pass.downloadToken}/pass.pkpass`, { 'if-none-match': '"x"' })).status,
    ).toBe(200);
  });

  it('serves the new link after a rotation and the latest bytes after an update', async () => {
    const pass = await kit.pass();
    const { downloadUrl } = await rotateLink(kit.ctx, actor, pass.id, null);
    const res = await get(new URL(downloadUrl).pathname);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });
});

describe('GET /p/:token/assets/:name', () => {
  it('serves template images as immutable PNG with validators', async () => {
    const pass = await kit.pass();
    const page = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(page).toBeTruthy();
    const res = await get(`/p/${pass.downloadToken}/assets/icon.png?v=v1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TINY_PNG);
    const etag = res.headers.get('etag') ?? '';
    const again = await get(`/p/${pass.downloadToken}/assets/icon.png`, { 'if-none-match': etag });
    expect(again.status).toBe(304);
  });

  it('prefers the per-pass override and keeps it private to that pass', async () => {
    const mine = await kit.pass();
    const other = await kit.pass();
    const png = ICON_PNG;
    await putPassAsset(kit.ctx, actor, mine.id, 'icon.png', png, null);
    const override = await get(`/p/${mine.downloadToken}/assets/icon.png`);
    expect(new Uint8Array(await override.arrayBuffer())).toEqual(png);
    const untouched = await get(`/p/${other.downloadToken}/assets/icon.png`);
    expect(new Uint8Array(await untouched.arrayBuffer())).toEqual(TINY_PNG);
  });

  it('lets other origins embed the icon and logo, the pass email images, and nothing else', async () => {
    const pass = await kit.pass();
    await putPassAsset(kit.ctx, actor, pass.id, 'thumbnail@2x.png', makePng(100, 100), null);
    const icon = await get(`/p/${pass.downloadToken}/assets/icon.png`);
    expect(icon.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    await icon.arrayBuffer();
    const thumb = await get(`/p/${pass.downloadToken}/assets/thumbnail@2x.png`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    await thumb.arrayBuffer();
  });

  it("lists an overridden slot's files only, as the signed pass has them", async () => {
    const pass = await kit.pass();
    await putPassAsset(kit.ctx, actor, pass.id, 'icon@2x.png', makePng(58, 58), null);
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain(`/p/${pass.downloadToken}/assets/icon@2x.png?v=`);
    expect(html).not.toContain(`/p/${pass.downloadToken}/assets/icon.png?v=`);
  });

  it('rejects names outside the pass image set', async () => {
    const pass = await kit.pass();
    for (const name of ['pass.json', 'missing.png', '..%2Fpass.png', 'icon.svg'])
      expect((await get(`/p/${pass.downloadToken}/assets/${name}`)).status).toBe(404);
  });
});

describe('org suspension', () => {
  it('stops the page, download and images while the org is suspended', async () => {
    const pass = await kit.pass();
    expect((await get(`/p/${pass.downloadToken}`)).status).toBe(200);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      for (const path of ['', '/pass.pkpass', '/assets/icon.png'])
        expect((await get(`/p/${pass.downloadToken}${path}`)).status).toBe(404);
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
    expect((await get(`/p/${pass.downloadToken}`)).status).toBe(200);
  });
});

describe('rate limit', () => {
  it('limits /p per client IP and answers problem+json', async () => {
    const pass = await kit.pass();
    const env = { ...kit.env, RL_PUBLIC: fakeLimiter(1) as unknown as RateLimit };
    const hit = (ip: string) =>
      app.request(
        `${ORIGIN}/p/${pass.downloadToken}`,
        { headers: { 'cf-connecting-ip': ip } },
        env,
      );
    expect((await hit('1.1.1.1')).status).toBe(200);
    const limited = await hit('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toContain('application/problem+json');
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect((await hit('2.2.2.2')).status).toBe(200);
  });

  it('keeps asset requests out of the page bucket', async () => {
    const pass = await kit.pass();
    const page = fakeLimiter(1);
    const env = { ...kit.env, RL_PUBLIC: page as unknown as RateLimit };
    for (let i = 0; i < 5; i++)
      await app.request(`${ORIGIN}/p/${pass.downloadToken}/assets/icon.png`, {}, env);
    const res = await app.request(`${ORIGIN}/p/${pass.downloadToken}`, {}, env);
    expect(res.status).toBe(200);
  });
});
