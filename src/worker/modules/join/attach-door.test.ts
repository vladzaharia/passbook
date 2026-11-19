// At the door (not_found: a credential retired by a transfer is gone, unlike an in-place new code): after a joined card attaches, nothing the joiner holds admits, and the owner's credentials do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { key, type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import { type PublicKit, publicKit, turnstile, verdictOf } from './public-test-fixtures.ts';

let t: PublicKit<ScanKit>;
beforeAll(async () => {
  t = await publicKit((id) => joinTemplate(id, undefined, true), setupScanKit);
}, 120_000);
afterAll(() => t.restore());

const door = async (headers: Record<string, string>, input: object): Promise<ScanOutcome> => {
  const res = await t.kit.post(headers, '/resolve', {
    idempotencyKey: key(),
    input,
    clientTs: t.kit.clock.now(),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body as ScanOutcome;
};

describe('the door after a joined card attaches', () => {
  it('refuses the joiner scan code, barcode, lookup value and serial; admits the owner', async () => {
    turnstile.verdict = verdictOf();
    await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
    const email = `door-${Math.random().toString(36).slice(2)}@example.test`;
    const l = await t.link({ askEmail: true });
    expect((await t.post(l, { email })).status).toBe(303);
    const row = await t.kit.env.DB.prepare('SELECT id FROM passes WHERE holder_email = ?')
      .bind(email)
      .first<{ id: string }>();
    if (!row) throw new Error('no joined pass');
    const before = await getPass(t.kit.env.DB, row.id);
    if (!before?.scanCode) throw new Error('no code');
    const scanner = await t.kit.scanner({ settings: { acceptAllTemplates: true } });
    const joiner = [
      { code: before.scanCode, method: 'camera' },
      { code: String(before.personalization.cardNumber), method: 'manual' },
      { code: before.serial, method: 'manual' },
    ] as const;
    // Before the attach each of them admits: the refusals below are the rotation's.
    for (const input of joiner)
      expect((await door(scanner.headers, input)).kind, input.method + input.code).not.toBe(
        'refused',
      );

    await signInMagicLink(jobCtxOf(t.kit), email, { ipPrefix: null, userAgent: null });
    const after = await getPass(t.kit.env.DB, row.id);
    if (!after?.scanCode) throw new Error('no new code');
    expect(after.ownerUserId).not.toBeNull();

    // The barcode is the scan code, so its hash moved with it.
    expect(after.barcodeHash).not.toBe(before.barcodeHash);
    for (const input of joiner)
      expect(await door(scanner.headers, input), input.method + input.code).toMatchObject({
        kind: 'refused',
        card: null,
        action: null,
      });
    for (const input of [
      { code: after.scanCode, method: 'camera' },
      { code: String(after.personalization.cardNumber), method: 'manual' },
      { code: after.serial, method: 'manual' },
    ] as const)
      expect((await door(scanner.headers, input)).kind, input.code).not.toBe('refused');
  });
});
