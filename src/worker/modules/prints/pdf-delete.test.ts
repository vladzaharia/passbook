import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { seedBundlePrincipal } from '../bundles/test-auth-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  ORIGIN,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from '../scan/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { dropPrintPdfs } from './pdf-drop.ts';
import { bulkKey, pdfKey } from './pdf-store.ts';
import { sweepPrintPdfs } from './pdf-sweep.ts';
import { pdfKit } from './pdf-test-fixtures.ts';

const DAY = 86_400_000;
const put = (bucket: R2Bucket, key: string) => bucket.put(key, '%PDF-x');
const keys = async (bucket: R2Bucket) =>
  (await bucket.list({ prefix: 'prints/' })).objects.map((o) => o.key).sort();

describe('PDF deletion hooks', () => {
  it('drops every PDF of a pass (purge) and only that pass', async () => {
    const { kit } = await pdfKit();
    const bucket = kit.env.BUCKET;
    await put(bucket, pdfKey(kit.org.id, 'p1', 'a'));
    await put(bucket, pdfKey(kit.org.id, 'p1', 'b'));
    await put(bucket, pdfKey(kit.org.id, 'p2', 'c'));
    await dropPrintPdfs(jobCtxOf(kit), { orgId: kit.org.id, id: 'p1' });
    expect(await keys(bucket)).toEqual([pdfKey(kit.org.id, 'p2', 'c')]);
    await dropPrintPdfs(jobCtxOf(kit), { orgId: kit.org.id, id: 'p2' }, 'c');
    expect(await keys(bucket)).toEqual([]);
  });

  it('sweeps PDFs of ended prints and old bulk files, and keeps active ones', async () => {
    const { kit, printPass, mint, staffPdf } = await pdfKit();
    const bucket = kit.env.BUCKET;
    const live = await printPass();
    const kept = await mint(live.id);
    await staffPdf(live.id);
    const ended = await printPass('ended@example.com');
    const gone = await mint(ended.id);
    await put(bucket, pdfKey(kit.org.id, ended.id, gone.id));
    // The void the inline hook missed: a trigger-driven end (pass void) with the PDF still there.
    await run(
      kit.env.DB,
      "UPDATE pass_prints SET status = 'voided', voided_at = 1, void_cause = 'new_code' WHERE id = ?",
      [gone.id],
    );
    await put(bucket, pdfKey(kit.org.id, 'purged-pass', 'no-such-print'));
    await put(bucket, bulkKey(kit.org.id, 'job-recent-0123456789', 'pdf'));
    const ctx = jobCtxOf(kit);
    await sweepPrintPdfs(ctx);
    expect(await keys(bucket)).toEqual(
      [
        pdfKey(kit.org.id, live.id, kept.id),
        bulkKey(kit.org.id, 'job-recent-0123456789', 'pdf'),
      ].sort(),
    );
    await sweepPrintPdfs({ ...ctx, clock: { now: () => Date.now() + 8 * DAY } });
    expect(await keys(bucket)).toEqual([pdfKey(kit.org.id, live.id, kept.id)]);
  });
});

describe('credential transfer deletes the PDFs', () => {
  let kit: ScanKit;
  let tpl: string;
  let headers: Record<string, string>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    kit = await setupScanKit();
    tpl = await kit.scanTemplate('Tickets', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const fake = fakeAuth(ORIGIN);
    app = createApp({ stores: fake.stores, clock: kit.clock });
    headers = fake.admin();
    await seedBundlePrincipal(kit, fake, headers);
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
    );
    clearSettingsCache(kit.env.DB);
  });

  it('removes the print PDFs of the pass when the holder changes', async () => {
    const call = (method: string, path: string, body?: unknown) =>
      app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        kit.env,
      );
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'first@example.com' });
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    const print = (await (await call('POST', `/passes/${pass.id}/prints`)).json()) as {
      id: string;
    };
    const key = pdfKey(pass.orgId, pass.id, print.id);
    await put(kit.env.BUCKET, key);
    await startScanCredentialTransfer(kit, pass.id, {
      target: { holderEmail: 'second@example.com', ownerUserId: null },
    });
    const [row] = await all<{ status: string }>(
      kit.env.DB,
      'SELECT status FROM pass_prints WHERE pass_id = ?',
      [pass.id],
    );
    expect(row?.status).toBe('voided');
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  });
});
