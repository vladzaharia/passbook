import { expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { BACKFILL_DONE, backfillScanLookups } from './jobs.ts';
import { makeLegacyScanPass, setupScanKit } from './test-kit.ts';

// A row whose JSON cannot be read must not keep the backfill from finishing, and must not take the
// healthy rows down with it (the old page read raised inside SQL on malformed JSON).
it('finishes with poison rows present and still keys the healthy ones', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Backfill poison', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    lookup: { input: 'memberNo' },
  });
  const template = await kit.registry.resolve(templateId);
  const healthy = await makeLegacyScanPass(kit.fx, {
    orgId: kit.org.id,
    template,
    personalization: { memberName: 'Anna Popescu', memberNo: 'GYM-7' },
  });
  const badPass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const badPersonalization = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const objectInput = await makeLegacyScanPass(kit.fx, {
    orgId: kit.org.id,
    template,
    personalization: { memberName: 'Ion', memberNo: { nested: true } },
  });
  await run(kit.env.DB, "UPDATE pass_versions SET pass_json = '{not json' WHERE pass_id = ?", [
    badPass.id,
  ]);
  // personalization is CHECKed as JSON, but its shape is free: an array carries no lookup value.
  await run(kit.env.DB, "UPDATE passes SET personalization = '[]' WHERE id = ?", [
    badPersonalization.id,
  ]);

  const ctx = createJobContext(kit.env, 'test', { clock: kit.clock });
  const warn = vi.spyOn(ctx.log, 'warn');
  // A few runs reach the end of the sweep, verify it, and complete.
  for (let i = 0; i < 4; i++) await backfillScanLookups(ctx);

  expect(
    await first(kit.env.DB, "SELECT value FROM settings WHERE scope = 'system' AND key = ?", [
      BACKFILL_DONE,
    ]),
  ).toEqual({ value: 'true' });
  for (const pass of [healthy, badPass, badPersonalization, objectInput]) {
    const row = await first<{ scan_code: string | null }>(
      kit.env.DB,
      'SELECT scan_code FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
  }
  expect(
    (
      await first<{ lookup_hash: string | null }>(
        kit.env.DB,
        'SELECT lookup_hash FROM passes WHERE id = ?',
        [healthy.id],
      )
    )?.lookup_hash,
  ).toMatch(/^[0-9a-f]{64}$/);
  expect(
    (
      await first<{ lookup_hash: string | null }>(
        kit.env.DB,
        'SELECT lookup_hash FROM passes WHERE id = ?',
        [objectInput.id],
      )
    )?.lookup_hash,
  ).toBeNull();
  // The skips are logged with stable codes.
  const codes = warn.mock.calls.map(([, fields]) => (fields as { code?: string }).code);
  expect(codes).toContain('SCAN_BACKFILL_MALFORMED_PASS');
});

it('does not bump row_version of the passes it fills', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Backfill bump', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  await run(
    kit.env.DB,
    "DELETE FROM settings WHERE scope = 'system' AND key LIKE 'scan.backfill%'",
  );
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const before = await first<{ row_version: number }>(
    kit.env.DB,
    'SELECT row_version FROM passes WHERE id = ?',
    [pass.id],
  );
  await backfillScanLookups(createJobContext(kit.env, 'test', { clock: kit.clock }));
  const after = await first<{ row_version: number; scan_code: string | null }>(
    kit.env.DB,
    'SELECT row_version, scan_code FROM passes WHERE id = ?',
    [pass.id],
  );
  expect(after?.scan_code).not.toBeNull();
  expect(after?.row_version).toBe(before?.row_version);
});
