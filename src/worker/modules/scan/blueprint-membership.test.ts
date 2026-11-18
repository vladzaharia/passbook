import { beforeAll, describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { ScanManifest } from '../../../passkit/types.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

function membership(): ScanManifest {
  const scan = bakedTemplates.find((t) => t.slug === 'starter-generic')?.manifest.scan;
  if (!scan) throw new Error('no scan block');
  const { display: _display, lookup: _lookup, ...rest } = scan;
  return rest;
}

describe('Membership at the scanner', () => {
  const desk = async () => {
    const t = await kit.scanTemplate('Membership', membership());
    return {
      t,
      s: await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'desk' } }),
    };
  };
  const checkIn = async (
    headers: Record<string, string>,
    pass: Parameters<typeof codeOf>[0],
    over = {},
  ) => out(await act(headers, codeOf(pass), { actionId: 'check_in', ...over }));

  it('admits an Active member', async () => {
    const { t, s } = await desk();
    const pass = await kit.scanPass(t, { status: 'Active', guests: 2 });
    expect(await checkIn(s.headers, pass)).toMatchObject({ kind: 'ok' });
  });

  it('holds a Frozen member for a check, and desk staff confirm admits them', async () => {
    const { t, s } = await desk();
    const pass = await kit.scanPass(t, { status: 'Frozen', guests: 2 });
    expect(await checkIn(s.headers, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
    });
    expect(await checkIn(s.headers, pass, { confirmed: true })).toMatchObject({ kind: 'ok' });
  });

  // Membership and Booking bind /voided to Cancelled (the passkit tests build it), so the built pass.json
  // carries voided: true. The scanner refuses such a pass like one whose record is voided, whatever the template.
  it('refuses a pass whose built JSON is voided, as a Cancelled member', async () => {
    const t = await kit.scanTemplate('Membership', membership(), { passStyle: { voided: true } });
    const s = await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'desk' } });
    const pass = await kit.scanPass(t, { status: 'Cancelled', guests: 2 });
    expect(await checkIn(s.headers, pass)).toMatchObject({ kind: 'refused', reason: 'voided' });
  });
});
