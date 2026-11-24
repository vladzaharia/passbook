import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { voidPass } from '../passes/service.ts';
import { pdfKey } from './pdf-store.ts';
import { FORBIDDEN, pdfKit, pdfText } from './pdf-test-fixtures.ts';

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());
const head = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5));

describe('staff PDF', () => {
  it('serves the active print as a no-store PDF and caches it in R2 by print', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    expect((await staffPdf(pass.id)).status).toBe(404);
    const print = await mint(pass.id);
    const res = await staffPdf(pass.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(head(await bytesOf(res))).toBe('%PDF-');
    const page = await (
      await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() })
    ).text();
    expect(page).toContain(`href="/api/v1/passes/${pass.id}/print/pdf"`);
    expect(page).toContain('Download PDF');
    const key = pdfKey(kit.org.id, pass.id, print.id);
    const stored = await kit.env.BUCKET.head(key);
    expect(stored?.customMetadata).toMatchObject({ passVersion: String(pass.version) });
  });

  it('hits the cache while the pass version is the same, and redraws when it moved', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    await staffPdf(pass.id);
    const key = pdfKey(kit.org.id, pass.id, print.id);
    const drawn = (await kit.env.BUCKET.head(key))?.customMetadata ?? {};
    const put = (version: number) =>
      kit.env.BUCKET.put(key, 'cached copy', {
        customMetadata: { ...drawn, passVersion: String(version) },
      });
    await put(pass.version);
    expect(await (await staffPdf(pass.id)).text()).toBe('cached copy');
    await put(pass.version + 1);
    expect(head(await bytesOf(await staffPdf(pass.id)))).toBe('%PDF-');
    expect((await kit.env.BUCKET.head(key))?.customMetadata?.passVersion).toBe(
      String(pass.version),
    );
  });

  it('redraws when what the drawing reads changed, even at the same pass version', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    await staffPdf(pass.id);
    const key = pdfKey(kit.org.id, pass.id, print.id);
    const drawn = (await kit.env.BUCKET.head(key))?.customMetadata ?? {};
    expect(drawn.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    await kit.env.BUCKET.put(key, 'cached copy', {
      customMetadata: { ...drawn, fingerprint: 'stale' },
    });
    expect(head(await bytesOf(await staffPdf(pass.id)))).toBe('%PDF-');
    expect((await kit.env.BUCKET.head(key))?.customMetadata?.fingerprint).toBe(drawn.fingerprint);
  });

  it('redraws when the plan changes what the footer shows, with no pass change', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    await staffPdf(pass.id);
    const key = pdfKey(kit.org.id, pass.id, print.id);
    const full = (await kit.env.BUCKET.head(key))?.customMetadata?.fingerprint;
    await run(kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ mark: 'none' }),
      kit.org.id,
    ]);
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'brand.mark', '\"none\"', 1)",
      [kit.org.id],
    );
    const text = await pdfText(await bytesOf(await staffPdf(pass.id)));
    expect(text).not.toContain('PassBook');
    const after = (await kit.env.BUCKET.head(key))?.customMetadata?.fingerprint;
    expect(after).toMatch(/^[0-9a-f]{24}$/);
    expect(after).not.toBe(full);
  });

  it('draws the print code and the holder, never the scan code, wallet barcode or serial', async () => {
    const { printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    const text = await pdfText(await bytesOf(await staffPdf(pass.id)));
    expect(text).toContain('Spring Concert');
    expect(text.replace(/\s/g, '')).toContain(print.code);
    for (const secret of [FORBIDDEN, pass.scanCode ?? 'no-scan-code', pass.serial, 'T-77'])
      expect(text).not.toContain(secret);
  });

  it('is 404 for another org, and for a reader key', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    await mint(pass.id);
    const foreign = await kit.auth.apiKey({
      orgId: (await makeOrg(kit.fx)).id,
      scopes: ['passes:write'],
    });
    expect([401, 403, 404]).toContain((await staffPdf(pass.id, foreign)).status);
    expect((await staffPdf(pass.id, kit.auth.user())).status).toBeGreaterThanOrEqual(403);
    const reader = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await staffPdf(pass.id, reader)).status).toBe(403);
    expect((await staffPdf('nope')).status).toBe(404);
  });

  it('stops serving once the print is voided, and deletes the PDF', async () => {
    const { kit, api, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    await staffPdf(pass.id);
    const key = pdfKey(kit.org.id, pass.id, print.id);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    expect((await api('POST', `/passes/${pass.id}/prints/${print.id}/void`)).status).toBe(200);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
    expect((await staffPdf(pass.id)).status).toBe(404);
  });

  it('deletes the PDF when the pass is voided', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const print = await mint(pass.id);
    await staffPdf(pass.id);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect(await kit.env.BUCKET.head(pdfKey(kit.org.id, pass.id, print.id))).toBeNull();
  });

  it('deletes the replaced print PDF on reprint and keeps the new one', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const pass = await printPass();
    const first = await mint(pass.id);
    await staffPdf(pass.id);
    const second = await mint(pass.id);
    expect(await kit.env.BUCKET.head(pdfKey(kit.org.id, pass.id, first.id))).toBeNull();
    await staffPdf(pass.id);
    expect(await kit.env.BUCKET.head(pdfKey(kit.org.id, pass.id, second.id))).not.toBeNull();
  });
});

describe('holder PDF', () => {
  it('needs an active print, and the link', async () => {
    const { kit, printPass, mint, holderPdf } = await pdfKit();
    const pass = await printPass();
    expect((await holderPdf(pass)).status).toBe(404);
    await mint(pass.id);
    const res = await holderPdf(pass);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(head(await bytesOf(res))).toBe('%PDF-');
    const unknown = await kit.app.request(
      `https://wallet.test/p/${'x'.repeat(30)}/print/pdf`,
      {},
      kit.env,
    );
    expect(unknown.status).toBe(404);
  });

  it('is refused after the link rotates', async () => {
    const { kit, printPass, mint, holderPdf, tokenOf } = await pdfKit();
    const pass = await printPass();
    const token = await tokenOf(pass);
    await mint(pass.id);
    expect((await holderPdf(pass, token)).status).toBe(200);
    await rotateLink(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect((await holderPdf(pass, token)).status).toBe(404);
  });

  it('is refused once a void ends the print', async () => {
    const { kit, printPass, mint, holderPdf } = await pdfKit();
    const pass = await printPass();
    await mint(pass.id);
    expect((await holderPdf(pass)).status).toBe(200);
    await voidPass(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect((await holderPdf(pass)).status).toBe(404);
    const [row] = await all<{ void_cause: string }>(
      kit.env.DB,
      'SELECT void_cause FROM pass_prints WHERE pass_id = ?',
      [pass.id],
    );
    expect(row?.void_cause).toBe('pass_voided');
  });

  it('is refused for a staff-only template, which staff can still download', async () => {
    const { printPass, mint, holderPdf, staffPdf } = await pdfKit();
    const pass = await printPass({ schema: 1, size: 'a4', barcode: 'qr', holder: false });
    await mint(pass.id);
    expect((await holderPdf(pass)).status).toBe(404);
    expect((await staffPdf(pass.id)).status).toBe(200);
  });
});
