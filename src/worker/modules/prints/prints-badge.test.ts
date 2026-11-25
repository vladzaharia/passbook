import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { holderChannels } from '../channels/gate.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handlePrintsBulk } from './jobs.ts';
import { imageIds } from './pdf-images.ts';
import { makePng } from './pdf-png-fixtures.ts';
import { setup } from './prints-page-fixtures.ts';

const BADGE_PASS = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.test',
  teamIdentifier: 'TEAM',
  serialNumber: 's-2',
  organizationName: 'Northwind',
  description: 'Staff badge',
  generic: {
    primaryFields: [{ key: 'holder', label: 'Name', value: 'Ada Lovelace' }],
    backFields: [{ key: 'terms', label: 'Terms', value: 'Wear it.' }],
  },
  barcodes: [
    { format: 'PKBarcodeFormatQR', message: 'SECRET-SCAN-CODE', messageEncoding: 'utf-8' },
  ],
} as unknown as PassJson;

/** A template that reads as a badge: group get-in, a photo at the door, a generic pass. */
const BADGE = {
  passJson: BADGE_PASS,
  manifest: {
    bindings: [{ to: { field: 'holder' }, value: '{{name}}' }],
    display: { title: '{{name}}', group: 'get-in' },
    scan: {
      lookup: { input: 'ticketNo' },
      display: {
        v: 1,
        holder: '{{inputs.name}}',
        photo: { minRole: 'door' },
        header: {},
        panels: [],
      },
    },
  } as unknown as Partial<TemplateManifest>,
};

const PNG = makePng({ width: 8, height: 8, type: 2 });

async function photo(
  kit: Awaited<ReturnType<typeof setup>>['kit'],
  pass: { id: string },
  include: 0 | 1,
) {
  const key = `photos/${kit.org.id}/${pass.id}.png`;
  await kit.env.BUCKET.put(key, PNG);
  await run(
    kit.env.DB,
    `INSERT OR REPLACE INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, include_in_pass, version, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'v1', 1)`,
    [pass.id, kit.org.id, key, `sha-${pass.id}`, PNG.length, include],
  );
}

describe('a badge is staff-only unless its block says otherwise', () => {
  it('a derived badge: no holder print, no print link, every holder call refused', async () => {
    const { kit, api, withPaper, token, holder, count } = await setup();
    const pass = await withPaper(undefined, BADGE);
    expect((await holderChannels(jobCtxOf(kit), pass as never)).holderPrint).toBe(false);
    const t = await token(pass);
    for (const path of ['', '/reprint', '/void']) {
      const res = await holder(t, 'POST', path);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PRINT_STAFF_ONLY' });
    }
    const page = await (await holder(t)).text();
    expect(page).toContain('Printing unavailable');
    const pdf = await kit.app.request(
      `https://wallet.test/p/${t}/print/pdf`,
      { headers: { origin: 'https://wallet.test' } },
      kit.env,
    );
    expect(pdf.status).toBeGreaterThanOrEqual(400);
    expect(await count(pass.id)).toBe(0);
    expect((await api('POST', `/passes/${pass.id}/prints`)).status).toBe(200);
  });

  it('a paper block without a kind or holder still reads the derived class', async () => {
    const { kit, withPaper } = await setup();
    const pass = await withPaper({ schema: 1, size: 'cr80', barcode: 'qr' }, BADGE);
    expect((await holderChannels(jobCtxOf(kit), pass as never)).holderPrint).toBe(false);
  });

  it('holder: true in the block opens it to the holder', async () => {
    const { kit, withPaper } = await setup();
    const pass = await withPaper({ schema: 1, size: 'cr80', barcode: 'qr', holder: true }, BADGE);
    expect((await holderChannels(jobCtxOf(kit), pass as never)).holderPrint).toBe(true);
  });
});

describe('the member photo on paper', () => {
  const open = { schema: 1, size: 'cr80', barcode: 'qr', kind: 'badge', holder: true };

  it('staff see any photo on the page; a holder only one included in the pass', async () => {
    const { kit, api, withPaper, token, holder } = await setup();
    const pass = await withPaper(open, BADGE);
    await photo(kit, pass, 0);
    await api('POST', `/passes/${pass.id}/prints`);
    const t = await token(pass);
    const staff = await (
      await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() })
    ).text();
    expect(staff).toContain('src="data:image/png;base64,');
    const kept = await (await holder(t)).text();
    expect(kept).not.toContain('data:image/png');
    expect(kept).toContain('pp-initials');

    await photo(kit, pass, 1);
    const shown = await (await holder(t)).text();
    expect(shown).toContain('src="data:image/png;base64,');
  });

  it('the PDF fingerprint follows the photo and the audience', async () => {
    const { kit, withPaper } = await setup();
    const pass = await withPaper(open, BADGE);
    const ctx = jobCtxOf(kit);
    const files = { photo: true as const };
    await photo(kit, pass, 0);
    expect((await imageIds(ctx, pass as never, files, 'staff')).photo).toBe(`photo:sha-${pass.id}`);
    expect((await imageIds(ctx, pass as never, files, 'holder')).photo).toBe('none');
    await photo(kit, pass, 1);
    expect((await imageIds(ctx, pass as never, files, 'holder')).photo).toBe(
      `photo:sha-${pass.id}`,
    );
  });

  it('a bulk job draws each pass its own photo', async () => {
    const { kit, api, withPaper } = await setup();
    const a = await withPaper(open, BADGE);
    const b = await withPaper(open, BADGE);
    const run1 = async () => {
      const res = await api('POST', '/passes/bulk-print', { ids: [a.id, b.id], orgId: kit.org.id });
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      const job = (kit.queue.sent as { kind: string; jobId: string }[]).find(
        (m) => m.kind === 'prints.bulk' && m.jobId === jobId,
      );
      await handlePrintsBulk(job as never, jobCtxOf(kit));
      const pdf = await api('GET', `/passes/bulk-print/${jobId}/pdf?orgId=${kit.org.id}`);
      return new Uint8Array(await pdf.arrayBuffer()).length;
    };
    const without = await run1();
    await photo(kit, a, 0);
    await photo(kit, b, 0);
    const withPhotos = await run1();
    expect(withPhotos).toBeGreaterThan(without);
    expect(await first(kit.env.DB, 'SELECT COUNT(*) AS n FROM member_photos')).toMatchObject({
      n: 2,
    });
  });
});
