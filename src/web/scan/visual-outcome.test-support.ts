import type { Json } from '../../passkit/types.ts';
import type { ScanDisplay } from '../../shared/contracts/scan-display.ts';
import { fixtureCard, fixtureOutcome } from './machine/fixture-data.test-support.ts';
import { VISUAL_PASS_JSON } from './visual-pass-fixtures.test-support.ts';

export function visualOutcome(id: string, name: string, style: string, display: ScanDisplay) {
  const baseCard = fixtureCard();
  const passJson = VISUAL_PASS_JSON[id];
  if (!passJson) throw new Error(`Missing Wallet preview fixture for ${id}.`);
  const card = fixtureCard({
    title: display.identity.holder,
    subtitle: display.header.meta,
    display,
    template: { ...baseCard.template, name, style },
    passView: {
      ...baseCard.passView,
      passJson: passJson as unknown as Json,
    },
  });
  const action =
    id === 'loyalty'
      ? { id: 'add_stamp', label: 'Stamp added', kind: 'add' as const }
      : id === 'wallet'
        ? { id: 'charge', label: 'Payment recorded', kind: 'take' as const }
        : id === 'coupon'
          ? { id: 'use_coupon', label: 'Offer redeemed', kind: 'use_up' as const }
          : { id: 'check_in', label: 'Checked in', kind: 'check_in' as const };
  return fixtureOutcome('ok', null, {
    action,
    card,
    template: { name, style },
    display,
  });
}
