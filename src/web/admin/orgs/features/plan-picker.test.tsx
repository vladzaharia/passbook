import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_PRESETS, presetValues } from '@/shared/contracts/entitlements.ts';
import { PRESET_LABEL } from '@/shared/copy/entitlements.ts';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { PlanPicker } from './plan-picker.tsx';

installDomShims();

const plans: PresetOptionDto[] = ENTITLEMENT_PRESETS.filter((p) => p !== 'developer').map((p) => ({
  preset: p,
  label: PRESET_LABEL[p],
  orgCount: 9,
  values: presetValues(p),
}));

function Harness({ current }: { current: string | null }) {
  const [picked, setPicked] = useState<string | null>(current);
  return <PlanPicker plans={plans} current={current} picked={picked} onPick={setPicked} />;
}

const tile = (name: string) =>
  within(screen.getByRole('radio', { name }).closest('[data-plan-tile]') as HTMLElement);

describe('PlanPicker', () => {
  it('lists the plans in order as one radio group, never the developer sandbox', () => {
    render(<Harness current="standard" />);
    expect(screen.getByRole('radiogroup', { name: 'Plan' })).toBeVisible();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([
      'trial',
      'starter',
      'standard',
      'business',
      'premium',
      'enterprise',
      'legacy',
    ]);
    expect(screen.queryByText('Developer sandbox')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Season Pass' })).toBeChecked();
  });

  it('shows each plan as aligned limits, what it includes and one footer row', () => {
    render(<Harness current="standard" />);
    const standard = tile('Season Pass');
    const rows = Object.fromEntries(
      standard.getAllByRole('term').map((t) => [t.textContent, t.nextElementSibling?.textContent]),
    );
    expect(rows).toEqual({
      Passes: 'No limit',
      Templates: '10',
      Scanners: '10',
      Members: '8',
      'API keys': '5',
    });
    expect(standard.getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      'Apple',
      'Google',
      'Samsung',
      'Paper',
      'NFC tags',
    ]);
    expect(standard.getByText('Footer')).toBeVisible();
    expect(standard.getByText('Powered by PassBook')).toBeVisible();
    // What a plan lacks is left out, not shown dashed.
    expect(tile('Stub').queryByText('Samsung')).toBeNull();
    expect(tile('Stub').getByText('Issued with PassBook')).toBeVisible();
    expect(tile('All Access').getByText('Footer').nextElementSibling).toHaveTextContent('None');
    expect(tile('Unlimited').getAllByText('No limit').length).toBe(5);
    expect(
      tile('Unlimited')
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual(['Apple', 'Google', 'Samsung', 'Paper', 'NFC tags', 'Copy-proof NFC']);
    expect(screen.queryByRole('button', { name: /Where PassBook shows/ })).toBeNull();
    expect(screen.queryByText(/organization/)).toBeNull();
  });

  it('marks the current plan and moves the pick without moving Current', async () => {
    const user = userEvent.setup();
    render(<Harness current="standard" />);
    expect(screen.getAllByText('Current')).toHaveLength(1);
    await user.click(screen.getByText('All Access'));
    expect(screen.getByRole('radio', { name: 'All Access' })).toBeChecked();
    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Season Pass' })).toHaveAccessibleDescription(
      /Current/,
    );
  });

  it('moves the pick with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness current="standard" />);
    screen.getByRole('radio', { name: 'Season Pass' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Backstage' })).toBeChecked();
  });

  it('has nothing picked and no badge before an org has a plan', () => {
    render(<Harness current={null} />);
    expect(screen.queryByText('Current')).toBeNull();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
  });
});
