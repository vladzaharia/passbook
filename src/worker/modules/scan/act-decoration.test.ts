import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { decorateScan } from './scan-write-grant.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

const FAIL_PHOTO = 'act_decoration_fail_photo';

afterEach(async () => {
  vi.restoreAllMocks();
  await run(kit.env.DB, `DROP TRIGGER IF EXISTS ${FAIL_PHOTO}`);
});

/** A pass whose check-in mints a photo grant after the commit. */
async function photoPass() {
  const scanner = await kit.scanner({ templateIds: [tpl] });
  const pass = await kit.scanPass(tpl);
  await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return { scanner, pass };
}

const recorded = (scanId: string) =>
  first<{ state: string; outcome: string }>(
    kit.env.DB,
    'SELECT state, outcome FROM scans WHERE id = ?',
    [scanId],
  );

describe('scan decoration after the commit', () => {
  it('mints the photo grant for a committed check-in (positive control)', async () => {
    const { scanner, pass } = await photoPass();
    const result = await out(await act(scanner.headers, codeOf(pass)));
    expect(result.kind).toBe('ok');
    expect(result.display?.identity.photo?.url).toContain('/assets/member.png?g=');
    expect(await recorded(result.scanId ?? '')).toEqual({ state: 'done', outcome: 'ok' });
  });

  it('keeps the committed check-in when the photo grant fails, and logs it', async () => {
    const { scanner, pass } = await photoPass();
    // Any failure of the decoration batch: here the provenance insert aborts.
    await run(
      kit.env.DB,
      `CREATE TRIGGER ${FAIL_PHOTO} BEFORE INSERT ON scan_asset_grant_provenance
       BEGIN SELECT RAISE(ABORT, 'decoration down'); END`,
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await act(scanner.headers, codeOf(pass));
    expect(response.status).toBe(200);
    const result = await out(response);
    expect(result.kind).toBe('ok');
    expect(result.display?.identity.photo?.url ?? null).toBeNull();
    expect(await recorded(result.scanId ?? '')).toEqual({ state: 'done', outcome: 'ok' });
    expect(
      await first(
        kit.env.DB,
        'SELECT pass_id FROM scan_gates WHERE pass_id = ? AND last_scan_id = ?',
        [pass.id, result.scanId],
      ),
    ).not.toBeNull();
    expect(logged.mock.calls.some(([line]) => String(line).includes('SCAN_FINISH_DEGRADED'))).toBe(
      true,
    );
  });
});

describe('decorateScan', () => {
  it('keeps the PIN refund when the photo statements fail', async () => {
    const insert = () =>
      kit.env.DB.prepare(
        "INSERT INTO counters (key, window_start, count) VALUES ('decorate-refund', 0, 1)",
      );
    let refunded = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The photo statement repeats the refund's primary key, so it fails after the refund committed.
    const results = await decorateScan(
      kit.ctx,
      {
        refundStatements: () => [insert()],
        markRefunded: () => {
          refunded = true;
        },
      },
      [insert()],
    );
    expect(results).toEqual([]);
    expect(refunded).toBe(true);
    expect(
      await first(kit.env.DB, "SELECT count FROM counters WHERE key = 'decorate-refund'"),
    ).toEqual({ count: 1 });
  });
});
