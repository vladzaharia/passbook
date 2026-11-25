import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_PRESETS, presetValues } from '@/shared/contracts/entitlements.ts';
import { PRESET_LABEL } from '@/shared/copy/entitlements.ts';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { lastSpan, PlanPicker } from './plan-picker.tsx';

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

describe('PlanPicker', () => {
  it('lists the plans in order as radios named by the plan, never the developer sandbox', () => {
    render(<Harness current="standard" />);
    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-labelledby'));
    expect(names).toHaveLength(5);
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([
      'trial',
      'starter',
      'standard',
      'premium',
      'legacy',
    ]);
    expect(screen.getByRole('radio', { name: 'Unlimited' })).toBeInTheDocument();
    expect(screen.queryByText('Developer sandbox')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked();
  });

  it('shows four facts computed from values, with no notes and no org counts', () => {
    render(<Harness current="standard" />);
    const standard = screen
      .getByRole('radio', { name: 'Standard' })
      .closest('label') as HTMLElement;
    expect(within(standard).getByText('5,000')).toBeVisible();
    expect(within(standard).getByText('25')).toBeVisible();
    const chips = within(within(standard).getByRole('list', { name: 'Channels' }));
    expect(chips.getAllByRole('listitem').map((c) => c.textContent)).toEqual([
      'Apple',
      'Google',
      'Samsung',
      'Print',
      'NFC tags',
    ]);
    const trial = screen.getByRole('radio', { name: 'Trial' }).closest('label') as HTMLElement;
    const off = within(trial).getAllByText('not included', { exact: false });
    expect(off.map((e) => e.parentElement?.textContent?.trim())).toEqual([
      'Google not included',
      'Samsung not included',
      'Print not included',
      'NFC not included',
    ]);
    const unlimited = screen
      .getByRole('radio', { name: 'Unlimited' })
      .closest('label') as HTMLElement;
    expect(within(unlimited).getByText('No limit on passes')).toBeInTheDocument();
    expect(within(unlimited).getByText('Copy-proof NFC')).toBeInTheDocument();
    expect(screen.queryByText(/organization/)).toBeNull();
  });

  it('marks the current plan and moves the pick without moving Current', async () => {
    const user = userEvent.setup();
    render(<Harness current="standard" />);
    expect(screen.getAllByText('Current')).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Premium' }));
    expect(screen.getByRole('radio', { name: 'Premium' })).toBeChecked();
    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Standard' })).toHaveAccessibleDescription(/Current/);
  });

  it('has nothing picked and no badge before an org has a plan', () => {
    render(<Harness current={null} />);
    expect(screen.queryByText('Current')).toBeNull();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
  });
});

describe('PlanPicker units', () => {
  it('says "1 pass" and "1 template" for a plan of one', () => {
    const one: PresetOptionDto = {
      preset: 'solo',
      label: 'Solo',
      orgCount: 0,
      values: { ...presetValues('trial'), 'passes.live': 1, templates: 1 },
    };
    render(<PlanPicker plans={[one]} current={null} picked={null} onPick={() => {}} />);
    expect(screen.getByText('pass')).toBeVisible();
    expect(screen.getByText('template')).toBeVisible();
  });
});

describe('lastSpan', () => {
  it('lets the last card fill a short row at two and three columns', () => {
    expect(lastSpan(4)).toBe('@[54rem]:col-span-3');
    expect(lastSpan(5)).toBe('@[36rem]:col-span-2 @[54rem]:col-span-2');
    expect(lastSpan(6)).toBe('');
  });
});
