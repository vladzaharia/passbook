import { expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { getScanRow, scanLogSnapshotPredicate } from './repo-feed.ts';
import { packOutputPredicate } from './repo-output-predicates.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

it('keeps private scan proof values out of packed JSON while comparing the exact snapshot', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Keyset snapshot', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', ['Étage 北', scanner.id]);
  const pass = await kit.scanPass(templateId, { memberName: 'Keyset private title' });
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as ScanOutcome;
  expect(outcome.kind).toBe('ok');
  if (!outcome.scanId) throw new Error('The signed scan must have an id.');
  const row = await getScanRow(kit.env.DB, outcome.scanId, kit.clock.now(), 'live');
  if (!row?.eventProof) throw new Error('The signed event proof must be available.');
  const predicate = scanLogSnapshotPredicate(row, kit.clock.now());
  const packed = packOutputPredicate(predicate);
  const metadata = String(packed.params[0]);
  for (const secret of [
    pass.id,
    outcome.scanId,
    scanner.id,
    'Étage 北',
    'Keyset private title',
    row.eventProof.event.data,
  ])
    expect(metadata).not.toContain(secret);
  expect(packed.params.length).toBeGreaterThan(1);
  expect(
    await first(kit.env.DB, `SELECT 1 AS matches WHERE ${predicate.sql}`, predicate.params),
  ).toEqual({ matches: 1 });
  await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [
    'Different scanner',
    scanner.id,
  ]);
  expect(
    await first(kit.env.DB, `SELECT 1 AS matches WHERE ${predicate.sql}`, predicate.params),
  ).toBeNull();
});

it('compares a value over one slice in slices, never as a whole hex string', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Large snapshot', {
    actions: [{ id: 'check_in', label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await kit.scanPass(templateId, { memberName: 'Large snapshot title' });
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  const outcome = (await response.json()) as ScanOutcome;
  if (!outcome.scanId) throw new Error('The signed scan must have an id.');
  const big = JSON.stringify({
    memberName: 'Large snapshot title',
    padding: 'x'.repeat(1_200_000),
  });
  await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [big, pass.id]);
  const row = await getScanRow(kit.env.DB, outcome.scanId, kit.clock.now(), 'live');
  if (row?.eventProof?.currentPersonalization !== big)
    throw new Error('The large personalization must be part of the proof inputs.');
  const predicate = scanLogSnapshotPredicate(row, kit.clock.now());
  expect(predicate.sql).toContain('substr(CAST(');
  for (const param of predicate.params)
    if (typeof param === 'string') expect(param.length).toBeLessThanOrEqual(750_000);
  expect(
    await first(kit.env.DB, `SELECT 1 AS matches WHERE ${predicate.sql}`, predicate.params),
  ).toEqual({ matches: 1 });
  await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
    big.replace('xxx', 'xxy'),
    pass.id,
  ]);
  expect(
    await first(kit.env.DB, `SELECT 1 AS matches WHERE ${predicate.sql}`, predicate.params),
  ).toBeNull();
});
