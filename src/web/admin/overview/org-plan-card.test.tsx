import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_KEYS, presetValues } from '@/shared/contracts/entitlements.ts';
import { installDomShims, json, stubFetch } from '@/web/lib/test-utils.tsx';
import { OrgPlanCard } from './org-plan-card.tsx';

installDomShims();

function show(
  preset: 'standard' | 'legacy' | 'developer',
  usage: Record<string, number>,
  label = 'Standard',
) {
  const values = presetValues(preset);
  stubFetch({
    '/api/v1/orgs/o1/entitlements': () =>
      json({
        orgId: 'o1',
        preset,
        label,
        items: ENTITLEMENT_KEYS.map((key) => ({ key, value: values[key], source: 'preset' })),
        usage,
      }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <OrgPlanCard orgId="o1" />
    </QueryClientProvider>,
  );
}

describe('OrgPlanCard', () => {
  it('shows use against each limit, the channels it has and the footer, with no upgrade button', async () => {
    show('standard', { 'passes.live': 3214, templates: 4, 'scanning.devices': 19, members: 2 });
    expect(await screen.findByRole('heading', { name: 'Standard' })).toBeVisible();
    expect(screen.getByText('3,214 of 5,000')).toBeVisible();
    expect(screen.getByText('4 of 25')).toBeVisible();
    const chips = within(screen.getByRole('list', { name: 'Channels' }));
    expect(chips.getAllByRole('listitem').map((c) => c.textContent)).toEqual([
      'Apple',
      'Google',
      'Samsung',
      'Print',
      'NFC tags',
    ]);
    expect(screen.getByText('Powered by PassBook')).toBeVisible();
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull();
  });

  it('warns at 80% of a limit and says to ask PassBook, only for that limit', async () => {
    show('standard', { 'passes.live': 4000, templates: 4, 'scanning.devices': 19, members: 2 });
    // Passes at 80% and scanners at 95%: two warnings; templates and members are well under.
    expect(await screen.findAllByText('Ask PassBook for more.')).toHaveLength(2);
    expect(screen.getByRole('progressbar', { name: 'Passes' })).toHaveAttribute(
      'aria-valuetext',
      '4,000 of 5,000',
    );
  });

  it('shows plain counts and no meter for a plan with no limits', async () => {
    show(
      'legacy',
      { 'passes.live': 12, templates: 1, 'scanning.devices': 0, members: 1 },
      'Unlimited',
    );
    expect(await screen.findByRole('heading', { name: 'Unlimited' })).toBeVisible();
    expect(screen.getByText('12 · No limit')).toBeVisible();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Ask PassBook for more.')).toBeNull();
    expect(screen.getByText('No PassBook footer')).toBeVisible();
  });

  it('has no row for a limit of 0, so never "0 of 0"', async () => {
    show(
      'developer',
      { 'passes.live': 0, templates: 2, 'scanning.devices': 0, members: 1 },
      'Developer sandbox',
    );
    expect(await screen.findByRole('heading', { name: 'Developer sandbox' })).toBeVisible();
    expect(screen.getByText('2 of 10')).toBeVisible();
    expect(screen.getByText('1 of 1')).toBeVisible();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
    expect(screen.queryByText('Passes')).toBeNull();
    expect(screen.queryByText('Scanners')).toBeNull();
  });
});
