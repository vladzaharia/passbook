import { beforeAll, describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { ScanManifest } from '../../../passkit/types.ts';
import { act, HOUR, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

// The test kit's template has its own inputs, so the blueprint's actions and window are used as shipped
// and its screen and lookup (which name inputs the kit lacks) are left out.
function blueprint(slug: string): ScanManifest {
  const scan = bakedTemplates.find((t) => t.slug === slug)?.manifest.scan;
  if (!scan) throw new Error(`${slug} has no scan block`);
  const { display: _display, lookup: _lookup, ...rest } = scan;
  return rest;
}
const desk = (templateId: string) =>
  kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'desk' } });

describe('blueprint scan blocks at the scanner', () => {
  it('charges a Balance card', async () => {
    const t = await kit.scanTemplate('Balance', blueprint('starter-store-card'));
    const s = await desk(t);
    const pass = await kit.scanPass(t, { balance: 40 });
    const charged = await out(
      await act(s.headers, codeOf(pass), { actionId: 'charge', amount: 10 }),
    );
    expect(charged).toMatchObject({ kind: 'ok', value: { before: 40, after: 30 } });
    const topped = await out(
      await act(s.headers, codeOf(pass), { actionId: 'top_up', amount: 25 }),
    );
    expect(topped).toMatchObject({ kind: 'ok', value: { before: 30, after: 55 } });
  });

  it('refuses a Coupon redeemed twice as voided', async () => {
    const t = await kit.scanTemplate('Coupon', blueprint('starter-coupon'));
    const s = await desk(t);
    const pass = await kit.scanPass(t);
    const first = await out(await act(s.headers, codeOf(pass), { actionId: 'redeem' }));
    expect(first.kind).toBe('ok');
    const second = await out(await act(s.headers, codeOf(pass), { actionId: 'redeem' }));
    expect(second).toMatchObject({ kind: 'refused', reason: 'voided' });
  });

  it('holds an Event ticket until its window opens', async () => {
    const t = await kit.scanTemplate('Event', blueprint('starter-event-ticket'));
    const s = await desk(t);
    const early = await kit.scanPass(t, {
      startsAt: new Date(kit.clock.now() + 4 * HOUR).toISOString(),
      endsAt: new Date(kit.clock.now() + 7 * HOUR).toISOString(),
    });
    expect(await out(await act(s.headers, codeOf(early), { actionId: 'check_in' }))).toMatchObject({
      kind: 'heads_up',
      reason: 'not_yet_valid',
    });
    const open = await kit.scanPass(t, {
      startsAt: new Date(kit.clock.now() + 2 * HOUR).toISOString(),
      endsAt: new Date(kit.clock.now() + 5 * HOUR).toISOString(),
    });
    expect((await out(await act(s.headers, codeOf(open), { actionId: 'check_in' }))).kind).toBe(
      'ok',
    );
  });
});
