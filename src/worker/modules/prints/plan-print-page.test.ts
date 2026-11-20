// MT4a review M3: the page and PDF of a ticket already printed still render after the plan drops print.
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { pdfKit } from './pdf-test-fixtures.ts';

describe('a printed ticket after the plan drops print', () => {
  it('still renders its PDF for staff and the holder; a pass with no ticket gets none', async () => {
    const { kit, printPass, mint, staffPdf, holderPdf } = await pdfKit();
    const pass = await printPass(undefined, 'holder@example.com');
    await mint(pass.id);
    expect((await staffPdf(pass.id)).status).toBe(200);
    await run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'print', '0', 1)`,
      [kit.org.id],
    );
    expect((await staffPdf(pass.id)).status).toBe(200);
    expect((await holderPdf(pass)).status).toBe(200);
    const fresh = await printPass(undefined, 'other@example.com');
    expect((await staffPdf(fresh.id)).status).toBe(404);
  });
});
