import { describe, expect, it } from 'vitest';
import { linkToken, persistTemplate } from '../../../../test/helpers/index.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../../passkit/template/paper-fixtures.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };
const ORIGIN = 'https://wallet.test';
const CODE = /P[A-Z2-7]{26}/;
const GROUPED = /P[A-Z2-7]{8} [A-Z2-7]{9} [A-Z2-7]{9}/;

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const api = (method: string, path: string, body?: unknown, headers = kit.auth.admin()) =>
    kit.api(path, {
      method,
      headers: { ...headers, ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** A pass of an event-ticket template with this `paper` block (none: the derived layout). */
  const withPaper = async (paper?: unknown) => {
    const resolved = kit.registry.add({
      id: `tpl-paper-${kit.fx.ids.token(4)}`,
      version: 'v1',
      manifest: {
        ...EVENT_MANIFEST,
        ...(paper === undefined ? {} : { paper }),
      } as TemplateManifest,
      passJson: EVENT_PASS as PassJson,
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: resolved.id,
      version: (await kit.registry.resolve(resolved.id)).version,
      orgId: kit.org.id,
      mode: 'live',
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: resolved.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { name: 'Ada', ticketNo: 'T-77' },
      holderEmail: 'holder@example.com',
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const res = await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    expect(res.status).toBe(200);
    return pass;
  };
  const token = (pass: { downloadToken: string }) => linkToken(kit.env, pass as never);
  const holder = (t: string, method = 'GET', path = '') =>
    kit.app.request(
      `${ORIGIN}/p/${t}/print${path}`,
      { method, headers: { origin: ORIGIN } },
      kit.env,
    );
  const count = async (passId: string) =>
    (await all(kit.env.DB, 'SELECT 1 FROM pass_prints WHERE pass_id = ?', [passId])).length;
  return { kit, api, withPaper, token, holder, count };
}

describe('holder print page', () => {
  it('shows a button first and the sheet after the POST; a GET never mints', async () => {
    const { withPaper, token, holder, count } = await setup();
    const pass = await withPaper();
    const t = await token(pass);
    const first = await holder(t);
    expect(first.status).toBe(200);
    const empty = await first.text();
    expect(empty).toContain('data-act="make"');
    expect(empty).not.toMatch(CODE);
    expect(await count(pass.id)).toBe(0);

    expect((await holder(t, 'POST')).status).toBe(200);
    const page = await holder(t);
    const html = await page.text();
    expect(html).toContain('class="pp-sheet pp-page pp-a4');
    expect(html).toMatch(GROUPED);
    // The org's bar leads; the PassBook band is not on a holder's print page.
    expect(html).toContain('<header class="sticky');
    expect(html).not.toContain('class="band"');
    expect(html).toContain('data-act="reprint"');
    expect(await count(pass.id)).toBe(1);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
  });

  it('says printing is unavailable when paper is off, and 404s an unknown link', async () => {
    const { kit, token, holder } = await setup();
    const pass = await kit.datedPass({}, 'h@example.com');
    const res = await holder(await token(pass));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Printing unavailable');
    expect(html).not.toContain('data-act=');
    expect((await holder('x'.repeat(30))).status).toBe(404);
  });

  it('honours a paper size and Code 128 (half sheet) from the template', async () => {
    const { withPaper, token, holder } = await setup();
    const pass = await withPaper({ schema: 1, size: 'half', barcode: 'code128' });
    const t = await token(pass);
    await holder(t, 'POST');
    const html = await (await holder(t)).text();
    expect(html).toContain('pp-half');
    expect(html).toContain('@page{size:210mm 148mm;margin:0}');
    expect(html).toContain('aria-label="Code 128 barcode. Ticket code');
  });
});

describe('paper.holder false', () => {
  const staffOnly = { schema: 1, size: 'a4', barcode: 'qr', holder: false };

  it('refuses every holder POST and shows no print page, while staff can still print', async () => {
    const { kit, api, withPaper, token, holder, count } = await setup();
    const pass = await withPaper(staffOnly);
    const t = await token(pass);
    for (const path of ['', '/reprint', '/void']) {
      const res = await holder(t, 'POST', path);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PRINT_STAFF_ONLY' });
    }
    expect(await count(pass.id)).toBe(0);
    const page = await (await holder(t)).text();
    expect(page).toContain('Printing unavailable');
    expect(page).not.toContain('data-act=');

    const staff = await api('POST', `/passes/${pass.id}/prints`);
    expect(staff.status).toBe(200);
    // A staff print is not the holder's to void or reprint, and its code is not on the holder page.
    expect((await holder(t, 'POST', '/void')).status).toBe(403);
    expect((await holder(t, 'POST', '/reprint')).status).toBe(403);
    expect(await (await holder(t)).text()).not.toMatch(CODE);
    const staffPage = await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() });
    expect(await staffPage.text()).toMatch(GROUPED);
  });
});

describe('audience and region', () => {
  const setZone = async (
    kit: Awaited<ReturnType<typeof setup>>['kit'],
    zone: string | undefined,
  ) => {
    if (zone)
      await run(
        kit.env.DB,
        "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, 'org.timeZone', ?, 'test', 1)",
        [`org:${kit.org.id}`, JSON.stringify(zone)],
      );
    clearSettingsCache(kit.env.DB);
  };

  it.each([
    ['America/Chicago', '--w:215.9', '--h:279.4'],
    ['Europe/Berlin', '--w:210', '--h:297'],
  ])('a holder prints a card on the %s home sheet, staff the exact page', async (zone, w, h) => {
    const { kit, api, withPaper, token, holder } = await setup();
    await setZone(kit, zone);
    const pass = await withPaper({ schema: 1, size: 'cr80', barcode: 'qr' });
    await api('POST', `/passes/${pass.id}/prints`);
    const holderHtml = await (await holder(await token(pass))).text();
    expect(holderHtml).toContain('class="pp-hs"');
    expect(holderHtml).toContain(w);
    expect(holderHtml).toContain(h);
    expect(holderHtml).toContain('class="pp-fold-line"');
    const staffHtml = await (
      await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() })
    ).text();
    expect(staffHtml).not.toContain('class="pp-hs"');
    expect(staffHtml).toContain('class="pp-sheet pp-page pp-cr80 ');
    expect(staffHtml).toContain('@page{size:85.6mm 54mm;margin:0}');
  });

  it('an explicit paper.sheet overrides the region for the holder', async () => {
    const { kit, api, withPaper, token, holder } = await setup();
    await setZone(kit, 'America/Chicago');
    const pass = await withPaper({ schema: 1, size: 'atb', barcode: 'qr', sheet: 'a4' });
    await api('POST', `/passes/${pass.id}/prints`);
    const html = await (await holder(await token(pass))).text();
    expect(html).toContain('--w:210');
    expect(html).toContain('class="pp-sheet pp-page pp-atb pp-strip');
  });

  it('a page size is its own for everyone, and a US org with no block prints on Letter', async () => {
    const { kit, api, withPaper, token, holder } = await setup();
    await setZone(kit, 'US/Eastern');
    const derived = await withPaper();
    await api('POST', `/passes/${derived.id}/prints`);
    expect(await (await holder(await token(derived))).text()).toContain(
      'class="pp-sheet pp-page pp-letter',
    );
    const a4 = await withPaper({ schema: 1, size: 'a4', barcode: 'qr' });
    await api('POST', `/passes/${a4.id}/prints`);
    expect(await (await holder(await token(a4))).text()).toContain('class="pp-sheet pp-page pp-a4');
  });
});

describe('staff print page', () => {
  it('shows the active print to passes:operate, nothing before one exists, and refuses readers', async () => {
    const { kit, api, withPaper } = await setup();
    const pass = await withPaper();
    const none = await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() });
    expect(none.status).toBe(200);
    const empty = await none.text();
    expect(empty).toContain('No active print.');
    expect(empty).not.toMatch(CODE);

    await api('POST', `/passes/${pass.id}/prints`);
    const res = await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() });
    const html = await res.text();
    expect(html).toContain('Print ticket');
    expect(html).toMatch(GROUPED);
    expect(html).not.toContain('data-act="reprint"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const missing = await kit.api('/passes/nope/print', { headers: kit.auth.admin() });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
    const reader = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const denied = await kit.api(`/passes/${pass.id}/print`, { headers: reader });
    expect(denied.status).toBe(403);
    const stranger = await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.user() });
    expect([403, 404]).toContain(stranger.status);
  });
});

describe('staff print page images', () => {
  it('serves a template image to passes:operate, refuses readers and unknown names', async () => {
    const { kit, api, withPaper } = await setup();
    const pass = await withPaper();
    await api('POST', `/passes/${pass.id}/prints`);
    const page = await (
      await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() })
    ).text();
    expect(page).toContain('Print ticket');
    const ok = await kit.api(`/passes/${pass.id}/print/assets/icon.png`, {
      headers: kit.auth.admin(),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    const missing = await kit.api(`/passes/${pass.id}/print/assets/nope.png`, {
      headers: kit.auth.admin(),
    });
    expect(missing.status).toBe(404);
    const reader = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const denied = await kit.api(`/passes/${pass.id}/print/assets/icon.png`, { headers: reader });
    expect(denied.status).toBe(403);
  });
});
