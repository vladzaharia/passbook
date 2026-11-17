import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

afterEach(() => {
  vi.restoreAllMocks();
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

  it('writes nothing to mint the grant: only the scan, its gate and its events change', async () => {
    const { scanner, pass } = await photoPass();
    expect(
      await first(kit.env.DB, "SELECT 1 FROM sqlite_master WHERE name LIKE 'scan_asset_grant%'"),
    ).toBeNull();
    const result = await out(await act(scanner.headers, codeOf(pass)));
    const url = result.display?.identity.photo?.url;
    expect(url).toContain('/assets/member.png?g=');
    // The grant redeems with no stored row behind it.
    const image = await kit.get(scanner.headers, (url ?? '').replace('/api/v1/scan', ''));
    expect(image.status).toBe(200);
    await image.body?.cancel();
  });
});
