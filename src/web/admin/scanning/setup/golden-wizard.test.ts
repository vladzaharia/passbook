import { describe, expect, it } from 'vitest';
import { initialDraft } from './draft.ts';
import golden from './golden-wizard.json';
import { toIntent } from './intent.ts';

const REFS = new Set(['id', 'ref', 'doorArea', 'inside', 'place']);
/** Counters differ by run order; the digits are not part of the answer. */
const stable = (_k: string, v: unknown) =>
  REFS.has(_k) && typeof v === 'string' ? v.replace(/\d+/g, '#') : v;

/** The wizard's starting answers and intents for the original presets, as origin/main made them. */
describe('wizard: original presets golden', () => {
  it('starts and sends exactly as before', () => {
    const out: unknown[] = [];
    for (const p of ['front_desk', 'event_night', 'venue'] as const)
      for (const tpl of [null, 'tpl_x']) {
        const d = initialDraft(p, 'UTC', tpl);
        const variants = [
          d,
          { ...d, any: true },
          { ...d, count: true, area: 'Inside', max: '40' },
          { ...d, hours: { ...d.hours, mode: 'set' as const, from: '09:00', to: '17:00' } },
          {
            ...d,
            scanners: 'staff' as const,
            staff: [{ id: 's', name: 'A', role: 'desk' as const }],
          },
        ];
        for (const v of variants) out.push({ p, tpl, draft: v, intent: toIntent(v, 'o1') });
      }
    expect(JSON.parse(JSON.stringify(out, stable))).toEqual(golden);
  });
});
