import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { TEST_BAND_COPY, TEST_PREVIEW_PATH } from '../../../shared/copy/developer.ts';
import { createApp } from '../../app.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { run } from '../../platform/db.ts';
import { mintPreviewLink, PREVIEW_LINK_TTL_MS } from '../developer/preview-link.ts';
import { detailOf, linksOf } from '../passes/detail.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';

const ORIGIN = 'https://passbook.mobile';
const DAY = 24 * 3_600_000;

let kit: Kit;
let dev: { id: string };
let std: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  dev = await makeOrg(kit.fx, { kind: 'developer', name: 'Dev Sandbox' });
  std = await makeOrg(kit.fx, { name: 'Standard Org' });
});
afterEach(() => vi.restoreAllMocks());

const devPass = () => kit.pass({ orgId: dev.id, mode: 'test', holderEmail: 'dev@example.com' });
const plainOf = (pass: Pass) =>
  revealToken(kit.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
const get = (path: string) =>
  createApp({ clock: kit.clock }).request(`${ORIGIN}${path}`, {}, kit.env);
const linkOf = (url: string) => url.slice(`${ORIGIN}${TEST_PREVIEW_PATH}`.length);
const bands = (html: string) => html.split(TEST_BAND_COPY).length - 1;

describe('/preview/<link>', () => {
  it('shows the four channels with the TEST band on each, noindex, and no Add button', async () => {
    const pass = await devPass();
    const { downloadUrl } = await linksOf(kit.ctx, pass, await plainOf(pass));
    expect(downloadUrl.startsWith(`${ORIGIN}${TEST_PREVIEW_PATH}`)).toBe(true);
    const res = await get(new URL(downloadUrl).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex');
    for (const tab of ['Apple', 'Google', 'Samsung', 'Paper'])
      expect(html).toContain(`>${tab}</label>`);
    // Apple front and back, Google, Samsung, and one per printed page.
    expect(bands(html)).toBeGreaterThanOrEqual(5);
    for (const pane of ['apple', 'google', 'samsung', 'paper']) {
      const body = html.split(`data-p="${pane}"`)[1]?.split('</section>')[0] ?? '';
      expect(body, pane).toContain(TEST_BAND_COPY);
    }
    expect(html).not.toMatch(/pass\.pkpass|Add to (Apple|Google|Samsung)|wallet\/v1|\/wallet\//i);
    expect(html).not.toContain(await plainOf(pass));
    // Every image the page names loads from under the link.
    const srcs = [...html.matchAll(/<img[^>]* src="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      const res = await get(new URL(src, ORIGIN).pathname);
      expect({ src, status: res.status }).toEqual({ src, status: 200 });
    }
  });

  it('answers 410 after 30 days and 200 until then', async () => {
    const pass = await devPass();
    const { downloadUrl } = await linksOf(kit.ctx, pass, await plainOf(pass));
    const path = new URL(downloadUrl).pathname;
    kit.clock.advance(PREVIEW_LINK_TTL_MS - 2 * 3_600_000);
    expect((await get(path)).status).toBe(200);
    kit.clock.advance(3 * 3_600_000);
    const gone = await get(path);
    expect(gone.status).toBe(410);
    expect(gone.headers.get('x-robots-tag')).toContain('noindex');
    const html = await gone.text();
    expect(html).toContain('Preview link expired');
    expect(html).not.toContain(TEST_BAND_COPY);
    kit.clock.advance(-PREVIEW_LINK_TTL_MS - DAY);
  });

  it('answers 404 for an altered, unknown or retired link', async () => {
    const pass = await devPass();
    const link = linkOf((await linksOf(kit.ctx, pass)).downloadUrl);
    const [id, gen, hour, mac] = link.split('.') as [string, string, string, string];
    const later = (Number.parseInt(hour, 36) + 900).toString(36);
    // A later hour (a longer life) or another pass id fails the MAC.
    for (const bad of [
      `${id}.${gen}.${later}.${mac}`,
      `${id.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}.${gen}.${hour}.${mac}`,
    ])
      expect((await get(`${TEST_PREVIEW_PATH}${bad}`)).status).toBe(404);
    expect((await get(`${TEST_PREVIEW_PATH}${await plainOf(pass)}`)).status).toBe(404);
    expect((await get(`${TEST_PREVIEW_PATH}${link}`)).status).toBe(200);
    expect((await get(`${TEST_PREVIEW_PATH}${link}/assets/icon.png`)).status).toBe(200);
    // Rotating the pass link retires the older preview link, page and images.
    await run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
      pass.id,
    ]);
    expect((await get(`${TEST_PREVIEW_PATH}${link}`)).status).toBe(404);
    expect((await get(`${TEST_PREVIEW_PATH}${link}/assets/icon.png`)).status).toBe(404);
  });

  it('shows no band for a live pass or a standard org, even with a link made for it', async () => {
    for (const mode of ['test', 'live'] as const) {
      const pass = await kit.pass({ orgId: std.id, mode, holderEmail: 'std@example.com' });
      const plain = await plainOf(pass);
      const link = await mintPreviewLink(
        kit.env,
        { passId: pass.id, linkGeneration: pass.linkGeneration },
        kit.clock.now(),
      );
      const res = await get(`${TEST_PREVIEW_PATH}${link}`);
      expect(res.status, mode).toBe(404);
      expect(await res.text(), mode).not.toContain(TEST_BAND_COPY);
      // The pass page itself carries no band.
      const page = await get(`/p/${plain}`);
      expect(await page.text(), mode).not.toContain(TEST_BAND_COPY);
      expect((await detailOf(kit.ctx, pass)).testPreview, mode).toBe(false);
    }
    expect((await detailOf(kit.ctx, await devPass())).testPreview).toBe(true);
  });

  it('never logs the link or the pass token', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      });
    const pass = await devPass();
    const plain = await plainOf(pass);
    const link = linkOf((await linksOf(kit.ctx, pass, plain)).downloadUrl);
    const [id, gen, hour, mac] = link.split('.') as [string, string, string, string];
    await get(`${TEST_PREVIEW_PATH}${link}`);
    await get(`${TEST_PREVIEW_PATH}${link}/assets/icon.png`);
    await get(`${TEST_PREVIEW_PATH}${id}.${gen}.${hour}.${'f'.repeat(32)}`);
    kit.clock.advance(PREVIEW_LINK_TTL_MS + DAY);
    await get(`${TEST_PREVIEW_PATH}${link}`);
    kit.clock.advance(-PREVIEW_LINK_TTL_MS - DAY);
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).toContain('/preview/:token');
    for (const secret of [link, plain, mac, id]) expect(all).not.toContain(secret);
  });
});
