import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fakeAuth,
  linkToken,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { MAC_REVEAL_SCRIPT } from '../../../shared/device.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { createPassRow } from '../passes/create.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { ICON_PNG, type Kit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import { voidPass } from '../passes/service.ts';
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
  it('renders the pass with one nonced inline script, no card flip and a download link', async () => {
    const pass = await kit.pass();
    // A Mac: the badge sits beside the QR.
    const res = await get(`/p/${await linkToken(kit.env, pass)}`, {
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
    // One details on the page: the list, not a flip to the card's back as well.
    expect(html).not.toContain('pc-flip-toggle');
    expect(html).toContain(`href="/p/${await linkToken(kit.env, pass)}/pass.pkpass"`);
    expect(html).toContain('alt="Add to Apple Wallet"');
    // The one inline script: a Mac agent may be an iPad, the browser shows the Mac's badge.
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline.map((m) => m[1])).toEqual([MAC_REVEAL_SCRIPT]);
    expect(html).toMatch(/<script nonce="[^"]+">if\(/);
  });

  it('does not advertise native wallets without approved projections and accounts', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).not.toContain(`/p/${await linkToken(kit.env, pass)}/wallet/google`);
    expect(html).not.toContain(`/p/${await linkToken(kit.env, pass)}/wallet/samsung`);
    expect(html).not.toContain('Add to Google Wallet');
    expect(html).not.toContain('Add to Samsung Wallet');
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
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain('Help: ');
    expect(html).toContain('href="mailto:help@gym.test"');
    expect(html).toContain('href="https://gym.test/help"');
    await put('support.url', 'javascript:alert(1)');
    clearSettingsCache(kit.env.DB);
    const unsafe = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(unsafe).not.toContain('javascript:');
    await run(kit.env.DB, 'DELETE FROM settings WHERE scope = ?', [`org:${kit.org.id}`]);
    clearSettingsCache(kit.env.DB);
    const fallback = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    // The platform's inbox is never offered on an org's page.
    expect(fallback).not.toContain('support@passbook.mobile');
    expect(fallback).not.toContain('gym.test');
  });

  it('sets the privacy headers and a nonce that matches the inline style', async () => {
    const pass = await kit.pass();
    const res = await get(`/p/${await linkToken(kit.env, pass)}`);
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
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
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
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', false, true],
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', true, true],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1', true, false],
    [
      'Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
      true,
      false,
    ],
  ])('on %s: the QR off the phone, the badge only where it adds', async (_name, ua, qr, badge) => {
    const pass = await kit.pass();
    const html = await (
      await get(`/p/${await linkToken(kit.env, pass)}`, { 'user-agent': ua })
    ).text();
    expect(html.includes('Scan with your iPhone camera.')).toBe(qr);
    expect(html.includes(`href="/p/${await linkToken(kit.env, pass)}/pass.pkpass"`)).toBe(badge);
    expect(html.includes('alt="Add to Apple Wallet"')).toBe(badge);
    // Without a badge there is nothing for Apple's open-elsewhere line to explain.
    expect(html).not.toContain('Open this page on your phone to add the pass to your wallet.');
  });

  it('asks in-app browsers to open Safari', async () => {
    const pass = await kit.pass();
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148';
    const html = await (
      await get(`/p/${await linkToken(kit.env, pass)}`, { 'user-agent': ua })
    ).text();
    expect(html).toContain('Open in Safari to add to Apple Wallet.');
  });

  it('leads with a QR of this page for desktop visitors, on a plain tile', async () => {
    const pass = await kit.pass();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
    const html = await (
      await get(`/p/${await linkToken(kit.env, pass)}`, { 'user-agent': ua })
    ).text();
    const qr = /<img src="(data:image\/svg\+xml;base64,[^"]+)" alt="QR code for ([^"]+)"/.exec(
      html,
    );
    expect(qr?.[2]).toBeTruthy();
    const svg = atob((qr?.[1] ?? '').split(',')[1] ?? '');
    expect(svg).toContain('<svg');
    expect(html).toContain('Scan with your iPhone camera.');
    // The scan opens this page on the iPhone, whose badge adds.
    expect(html).toMatch(
      /<div class="wl-sign">[\s\S]*?<span class="wl-sign-qr [^"]*"><img src="data:/,
    );
  });

  it('lists My passes in the other ways only when the pass has a holder email', async () => {
    const row = /<a class="wl-other" href="([^"]+)">(?:(?!<\/a>)[\s\S])*?<span>My passes<\/span>/g;
    const bare = await kit.pass();
    const none = await (await get(`/p/${await linkToken(kit.env, bare)}`)).text();
    expect(none).not.toContain('My passes</span>');
    expect(none).not.toContain('Open in My passes');
    const mailed = await kit.pass({ holderEmail: 'holder@example.test' });
    const html = await (await get(`/p/${await linkToken(kit.env, mailed)}`)).text();
    expect([...html.matchAll(row)].map((m) => m[1])).toEqual([`/passes/${mailed.id}`]);
  });

  it('links a voided pass to the org support, once', async () => {
    const pass = await kit.pass();
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1)',
      [`org:${kit.org.id}`, 'support.email', JSON.stringify('help@gym.test')],
    );
    clearSettingsCache(kit.env.DB);
    await voidPass(jobCtxOf(kit), actor, pass.id, null);
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    const note = /<div role="status"[^>]*>[\s\S]*?<\/div><\/div><\/div>/.exec(html)?.[0] ?? '';
    expect(note).toMatch(/This pass was voided on [A-Z][a-z]+ \d+, \d{4}\./);
    expect(note).toMatch(/href="mailto:help@gym.test"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Contact /);
    expect(html.match(/mailto:help@gym.test/g)).toHaveLength(1);
    await run(kit.env.DB, 'DELETE FROM settings WHERE scope = ?', [`org:${kit.org.id}`]);
    clearSettingsCache(kit.env.DB);
  });

  it('shows a voided banner and no download for a voided pass', async () => {
    const pass = await kit.pass();
    await voidPass(jobCtxOf(kit), actor, pass.id, null);
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain('This pass was voided.');
    expect(html).not.toContain('Add to Apple Wallet');
    expect(html).not.toContain('/wallet/google');
    expect(html).not.toContain('/wallet/samsung');
    expect(html).not.toContain('QR code');
    // Quiet: a fade in, no deal, glow or tilt (and no tilt script).
    expect(html).toContain('data-enter="quiet"');
    expect(html).not.toContain('data-tilt');
    expect(html).toContain('data-glow="off"');
    expect(html).not.toContain('pass-tilt.js');
  });

  it('says a removed pass was removed from Wallet, with the org note, not voided', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, { message: 'Season ended <b>.' }, null);
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain('This pass was removed.');
    expect(html).toContain('Season ended &lt;b&gt;.');
    expect(html).not.toContain('This pass was voided.');
    expect(html).not.toContain('Add to Apple Wallet');
    expect(html).not.toContain('/wallet/google');
    expect(html).not.toContain('/wallet/samsung');
    expect(html).toContain('data-removed');
    expect(html).not.toContain('class="pc-void"');
  });

  it('shows an expired banner', async () => {
    const { resolved } = makeTemplate({ id: `tpl-exp-${kit.fx.ids.token(4)}` });
    const template = kit.registry.add({
      id: resolved.id,
      version: 'v1',
      manifest: resolved.manifest,
      passJson: { ...resolved.passJson, expirationDate: '2020-01-01T00:00:00Z' },
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: template.id,
      version: template.version,
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: resolved.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Old' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain('This pass has expired.');
  });

  it('formats dates in the visitor zone from request.cf, Seattle time otherwise', async () => {
    const { resolved } = makeTemplate({ id: `tpl-tz-${kit.fx.ids.token(4)}` });
    const template = kit.registry.add({
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
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: template.id,
      version: template.version,
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: resolved.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Zed' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const url = `${ORIGIN}/p/${await linkToken(kit.env, pass)}`;
    const la = new Request(url, { cf: { timezone: 'America/Los_Angeles' } } as RequestInit);
    expect(await (await app.request(la, {}, kit.env)).text()).toMatch(/1:00\sAM/);
    const bad = new Request(url, { cf: { timezone: 'Not/AZone' } } as RequestInit);
    expect(await (await app.request(bad, {}, kit.env)).text()).toMatch(/1:00\sAM/);
    expect(await (await get(`/p/${await linkToken(kit.env, pass)}`)).text()).toMatch(/1:00\sAM/);
  });

  it('has a heading, and its only inline styles are pass colour variables', async () => {
    const pass = await kit.pass();
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
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
      (await get(`/p/${await linkToken(kit.env, pass)}`)).headers.get('content-security-policy') ??
      '';
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
    expect(body).toContain('<h1>This pass link does not work</h1>');
    expect(body).toContain('It may have been replaced.');
    expect(body).toContain('class="card" data-state="expired"');
    // The one way on opens the login with the reason; it names no pass, org or address.
    expect(body).toMatch(
      /<a class="btn" href="\/login\?next=\/&amp;reason=link"><svg[\s\S]*?<\/svg>Email me my passes<\/a>/,
    );
    const oldToken = await linkToken(kit.env, pass);
    await rotateLink(kit.ctx, actor, pass.id, null);
    expect((await get(`/p/${oldToken}`)).status).toBe(404);
    await expectProblem(await get(`/p/${oldToken}/pass.pkpass`), 404, 'LINK_NOT_FOUND');
  });
});

describe('GET /p/:token/pass.pkpass', () => {
  it('downloads the signed pass with validators and the right MIME type', async () => {
    const pass = await kit.pass();
    const res = await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('etag')).toBe(`"${pass.objectSha256}"`);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(pass.objectSize);
  });

  it('answers 304 to matching validators', async () => {
    const pass = await kit.pass();
    const first = await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`);
    await first.arrayBuffer();
    const etag = first.headers.get('etag') ?? '';
    const lastModified = first.headers.get('last-modified') ?? '';
    expect(
      (await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`, { 'if-none-match': etag }))
        .status,
    ).toBe(304);
    expect(
      (
        await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`, {
          'if-modified-since': lastModified,
        })
      ).status,
    ).toBe(304);
    expect(
      (await get(`/p/${await linkToken(kit.env, pass)}/pass.pkpass`, { 'if-none-match': '"x"' }))
        .status,
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
  it('serves private, non-cacheable template PNG images with validators', async () => {
    const pass = await kit.pass();
    const page = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(page).toBeTruthy();
    const res = await get(`/p/${await linkToken(kit.env, pass)}/assets/icon.png?v=v1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TINY_PNG);
    const etag = res.headers.get('etag') ?? '';
    const again = await get(`/p/${await linkToken(kit.env, pass)}/assets/icon.png`, {
      'if-none-match': etag,
    });
    expect(again.status).toBe(304);
  });

  it('prefers the per-pass override and keeps it private to that pass', async () => {
    const mine = await kit.pass();
    const other = await kit.pass();
    const png = ICON_PNG;
    await putPassAsset(jobCtxOf(kit), actor, mine.id, 'icon.png', png, null);
    const override = await get(`/p/${await linkToken(kit.env, mine)}/assets/icon.png`);
    expect(new Uint8Array(await override.arrayBuffer())).toEqual(png);
    const untouched = await get(`/p/${await linkToken(kit.env, other)}/assets/icon.png`);
    expect(new Uint8Array(await untouched.arrayBuffer())).toEqual(TINY_PNG);
  });

  it('lets other origins embed the icon and logo, the pass email images, and nothing else', async () => {
    const pass = await kit.pass();
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'thumbnail@2x.png', makePng(100, 100), null);
    const icon = await get(`/p/${await linkToken(kit.env, pass)}/assets/icon.png`);
    expect(icon.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    await icon.arrayBuffer();
    const thumb = await get(`/p/${await linkToken(kit.env, pass)}/assets/thumbnail@2x.png`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    await thumb.arrayBuffer();
  });

  it("lists an overridden slot's files only, as the signed pass has them", async () => {
    const pass = await kit.pass();
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo@2x.png', makePng(58, 58), null);
    const html = await (await get(`/p/${await linkToken(kit.env, pass)}`)).text();
    expect(html).toContain(`/p/${await linkToken(kit.env, pass)}/assets/logo@2x.png?v=`);
    expect(html).not.toContain(`/p/${await linkToken(kit.env, pass)}/assets/logo.png?v=`);
  });

  it('rejects names outside the pass image set', async () => {
    const pass = await kit.pass();
    for (const name of ['pass.json', 'missing.png', '..%2Fpass.png', 'icon.svg'])
      await expectProblem(
        await get(`/p/${await linkToken(kit.env, pass)}/assets/${name}`),
        404,
        'ASSET_NOT_FOUND',
      );
  });
});

describe('org suspension', () => {
  it('stops the page, download and images while the org is suspended', async () => {
    const pass = await kit.pass();
    expect((await get(`/p/${await linkToken(kit.env, pass)}`)).status).toBe(200);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      for (const path of ['', '/pass.pkpass', '/assets/icon.png'])
        expect((await get(`/p/${await linkToken(kit.env, pass)}${path}`)).status).toBe(404);
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
    expect((await get(`/p/${await linkToken(kit.env, pass)}`)).status).toBe(200);
  });
});

describe('rate limit', () => {
  it('limits /p per client IP and answers problem+json', async () => {
    const pass = await kit.pass();
    const env = { ...kit.env, RL_PUBLIC: fakeLimiter(1) as unknown as RateLimit };
    const hit = async (ip: string) =>
      app.request(
        `${ORIGIN}/p/${await linkToken(kit.env, pass)}`,
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
      await app.request(`${ORIGIN}/p/${await linkToken(kit.env, pass)}/assets/icon.png`, {}, env);
    const res = await app.request(`${ORIGIN}/p/${await linkToken(kit.env, pass)}`, {}, env);
    expect(res.status).toBe(200);
  });
});

describe('POST /p/:token/resend', () => {
  it('queues the pass for its own holder and redirects back to the page', async () => {
    const sent: unknown[] = [];
    const env = {
      ...kit.env,
      RL_REFRESH: fakeLimiter(1000) as unknown as RateLimit,
      RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit,
      JOBS: { send: async (job: unknown) => void sent.push(job) } as unknown as Queue,
    };
    const pass = await kit.pass({ holderEmail: 'holder@example.test' });
    const token = await linkToken(kit.env, pass);
    const res = await app.request(
      `${ORIGIN}/p/${token}/resend`,
      { method: 'POST', headers: { origin: ORIGIN } },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/p/${token}?again=sent`);
    expect(sent).toEqual([
      { kind: 'pass.holder_mail', passId: pass.id, userId: null, reason: 'resend' },
    ]);
    const cross = await app.request(
      `${ORIGIN}/p/${token}/resend`,
      { method: 'POST', headers: { origin: 'https://evil.test' } },
      env,
    );
    expect(cross.status).toBe(403);
    expect(sent).toHaveLength(1);
    const page = await (await app.request(`${ORIGIN}/p/${token}?again=sent`, {}, env)).text();
    expect(page).toContain('Email me this pass again');
    expect(page).toContain('Sent. Check your email.');
  });

  it('sends nothing for a pass without a holder email', async () => {
    const sent: unknown[] = [];
    const env = {
      ...kit.env,
      RL_REFRESH: fakeLimiter(1000) as unknown as RateLimit,
      RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit,
      JOBS: { send: async (job: unknown) => void sent.push(job) } as unknown as Queue,
    };
    const pass = await kit.pass();
    const token = await linkToken(kit.env, pass);
    const res = await app.request(
      `${ORIGIN}/p/${token}/resend`,
      { method: 'POST', headers: { origin: ORIGIN } },
      env,
    );
    expect(res.status).toBe(303);
    expect(sent).toEqual([]);
  });

  it('answers the same for an unknown token and refuses a malformed one', async () => {
    const sent: unknown[] = [];
    const env = {
      ...kit.env,
      RL_REFRESH: fakeLimiter(1000) as unknown as RateLimit,
      RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit,
      JOBS: { send: async (job: unknown) => void sent.push(job) } as unknown as Queue,
    };
    const post = (token: string) =>
      app.request(
        `${ORIGIN}/p/${token}/resend`,
        { method: 'POST', headers: { origin: ORIGIN } },
        env,
      );
    const unknown = await post('A'.repeat(32));
    expect(unknown.status).toBe(303);
    expect(unknown.headers.get('location')).toBe(`/p/${'A'.repeat(32)}?again=sent`);
    expect(sent).toEqual([]);
    for (const bad of ['abc%0d%0aSet-Cookie:x', 'short']) {
      const res = await post(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });
});
