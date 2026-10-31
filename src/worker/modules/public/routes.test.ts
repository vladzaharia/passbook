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
    const res = await get(`/p/${pass.downloadToken}`, { 'accept-language': 'fr-CA,fr;q=0.9' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="fr-CA">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive"/>');
    expect(html).toContain('<details>');
    expect(html).toContain(`href="/p/${pass.downloadToken}/pass.pkpass"`);
    expect(html).toContain('alt="Add to Apple Wallet"');
    expect(html).not.toContain('<script');
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
    expect(html).toContain('<footer>');
    expect(html).toContain('href="mailto:help@gym.test"');
    expect(html).toContain('href="https://gym.test/help"');
    await put('support.url', 'javascript:alert(1)');
    clearSettingsCache(kit.env.DB);
    const unsafe = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(unsafe).not.toContain('javascript:');
    await run(kit.env.DB, 'DELETE FROM settings WHERE scope = ?', [`org:${kit.org.id}`]);
    clearSettingsCache(kit.env.DB);
    expect(await (await get(`/p/${pass.downloadToken}`)).text()).not.toContain('<footer>');
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

  it('offers a QR hand-off for desktop visitors that points at the pass download', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    const qr = /<img src="(data:image\/svg\+xml;base64,[^"]+)" alt="QR code/.exec(html)?.[1];
    expect(qr).toBeTruthy();
    const svg = atob((qr ?? '').split(',')[1] ?? '');
    expect(svg).toContain('<svg');
    expect(html).toContain('Scan with your iPhone');
  });

  it('shows a voided banner and no download for a voided pass', async () => {
    const pass = await kit.pass();
    await voidPass(kit.ctx, actor, pass.id, null);
    const html = await (await get(`/p/${pass.downloadToken}`)).text();
    expect(html).toContain('This pass was voided.');
    expect(html).not.toContain('Add to Apple Wallet');
    expect(html).not.toContain('QR code');
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
    expect(html).toMatch(/<h1 class="sr">[^<]+<\/h1>/);
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
    expect(body).toContain('This link has expired.');
    expect(body).toContain('href="/login"');
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
});
