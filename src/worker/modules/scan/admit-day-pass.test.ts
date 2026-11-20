import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { generatedSource } from '../templates/sync.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

const NY = 'America/New_York';
// 10:00 EST. New York midnight is 05:00 UTC.
const MORNING = Date.UTC(2026, 10, 5, 15, 0, 0);
const MIDNIGHT = Date.UTC(2026, 10, 6, 5, 0, 0);

let kit: ScanKit;
let baseline: number;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  baseline = kit.clock.now();
  const starter = generatedSource.templates.find((t) => t.slug === 'starter-day-pass');
  if (!starter?.manifest.scan) throw new Error('starter-day-pass is not baked');
  template = await kit.scanTemplate('Day pass', starter.manifest.scan);
});
beforeEach(() => kit.clock.set(MORNING));

async function scan(pass: Awaited<ReturnType<typeof kit.scanPass>>) {
  const scanner = await kit.scanner({ templateIds: [template] });
  await run(kit.env.DB, 'UPDATE scanners SET time_zone = ? WHERE id = ?', [NY, scanner.id]);
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'enter',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

describe('a pass made from the Day pass blueprint', () => {
  it('admits in the morning and is refused after local midnight', async () => {
    const pass = await kit.scanPass(template, { plan: 'day', status: 'Active' });
    expect((await scan(pass)).kind).toBe('ok');
    kit.clock.set(MIDNIGHT - 1);
    expect((await scan(pass)).kind).toBe('ok');
    kit.clock.set(MIDNIGHT);
    const late = await scan(pass);
    expect(late.kind).not.toBe('ok');
    expect(late.reason).toBe('ended');
  });

  it('refuses a suspended pass', async () => {
    const pass = await kit.scanPass(template, { plan: 'day', status: 'Suspended' });
    const out = await scan(pass);
    expect(out.kind).not.toBe('ok');
    expect(out.reason).toBe('suspended');
  });
});

it('keeps the baseline clock for later files', () => {
  kit.clock.set(baseline);
});
