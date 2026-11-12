import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { credentialRefChecks } from './repo-scan-checks.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Credential refs', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

const scan = async (headers: Record<string, string>, code: string) => {
  const res = await kit.post(headers, '/actions', {
    input: { code, method: 'camera' },
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'auto',
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ScanOutcome;
};

/**
 * The other-mode tombstone check is refused by the tenant lint when it is built, so a scan that built
 * it would answer 500. No scan path builds it: the miss stop passes no other-mode refs, and the
 * other-mode refusal (`test_pass`) writes its stop without credential refs.
 */
describe('the other-mode credential check is never built by a scan', () => {
  it('as written, the check is refused when built', () => {
    expect(() => credentialRefChecks({ current: [], other: ['a'.repeat(64)] })).toThrow(/mode/);
    expect(credentialRefChecks({ current: ['a'.repeat(64)], other: [] })).toHaveLength(1);
  });

  it('a pass of the other mode and a passless miss both answer 200', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const other = await kit.scanPass(tpl, {}, { mode: 'test' });
    expect(await scan(scanner.headers, codeOf(other).code)).toMatchObject({
      kind: 'refused',
      reason: 'test_pass',
    });
    expect(await scan(scanner.headers, 'NO-SUCH-CODE-0001')).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
    });
  });
});
