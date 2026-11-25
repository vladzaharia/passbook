import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { presetValues } from '@/shared/contracts/entitlements.ts';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { PlanPicker } from './plan-picker.tsx';

installDomShims();

const plans: PresetOptionDto[] = (['trial', 'standard', 'premium'] as const).map((p) => ({
  preset: p,
  label: p[0]?.toUpperCase() + p.slice(1),
  orgCount: 1,
  values: presetValues(p),
}));

describe('plan footer', () => {
  it('quotes the smallest footer a plan allows', () => {
    render(<PlanPicker plans={plans} current="trial" picked="trial" onPick={() => {}} />);
    const text = (name: string) =>
      (screen.getByRole('radio', { name }).closest('label') as HTMLElement).textContent;
    expect(text('Trial')).toContain('Issued with');
    expect(text('Standard')).toContain('Powered by PassBook');
    expect(text('Premium')).toContain('No PassBook footer');
  });

  it('opens where PassBook shows from the info button, without picking the card', async () => {
    const user = userEvent.setup();
    const picks: string[] = [];
    render(
      <PlanPicker plans={plans} current="trial" picked="trial" onPick={(p) => picks.push(p)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Where PassBook shows on Standard' }));
    const pop = await screen.findByText('Where holders see PassBook');
    const box = pop.parentElement as HTMLElement;
    expect(within(box).getByText('Wallet passes')).toBeVisible();
    expect(within(box).getAllByText('Powered by PassBook').length).toBeGreaterThan(0);
    expect(within(box).getByText('The org picks its footer in Brand.')).toBeVisible();
    expect(picks).toEqual([]);
  });

  it('names the org on the email sender row where it is known', async () => {
    const user = userEvent.setup();
    render(
      <PlanPicker
        plans={plans}
        current="trial"
        picked="trial"
        onPick={() => {}}
        orgName="Acme Gym"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Where PassBook shows on Standard' }));
    expect(await screen.findByText('Acme Gym via PassBook')).toBeVisible();
  });
});
