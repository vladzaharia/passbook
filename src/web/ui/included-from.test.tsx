import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../lib/providers.tsx';
import { createQueryClient } from '../lib/query-client.ts';
import { type IncludedFromProps, IncludedFromView } from './included-from.tsx';

async function show(props: Partial<IncludedFromProps> = {}) {
  const root = createRootRoute({
    component: () => (
      <IncludedFromView
        plan={{ id: 'standard', name: 'Season Pass' }}
        line="Customer-facing screens show a live check-in."
        canManage
        planHref="/admin/o/o1/plan"
        {...props}
      />
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await router.load();
  await screen.findByRole('heading', { level: 1 });
}
const names = () =>
  [...document.querySelectorAll('[data-testid="state-view"] a, [data-testid="state-view"] button')]
    .map((el) => el.textContent?.trim())
    .filter(Boolean);

describe('IncludedFromView', () => {
  it.each([
    ['standard', 'Season Pass'],
    ['business', 'Backstage'],
  ])('says Included from %s with its plan icon', async (id, name) => {
    await show({ plan: { id, name } });
    expect(screen.getByRole('heading', { name: `Included from ${name}` })).toBeInTheDocument();
    expect(document.querySelector(`[data-plan-icon="${id}"] svg`)).not.toBeNull();
    expect(screen.getByText('Customer-facing screens show a live check-in.')).toBeInTheDocument();
  });

  it('with billing rights: Upgrade, AutoUp when eligible, Compare plans', async () => {
    await show({ autoUpEligible: true, onAutoUp: () => {} });
    expect(names()).toEqual(['Upgrade to Season Pass', 'Turn on AutoUp', 'Compare plans']);
    expect(screen.getByRole('link', { name: 'Upgrade to Season Pass' })).toHaveAttribute(
      'href',
      '/admin/o/o1/plan',
    );
  });

  it('hides AutoUp when not eligible', async () => {
    await show();
    expect(names()).toEqual(['Upgrade to Season Pass', 'Compare plans']);
  });

  it('without billing rights: Compare plans only', async () => {
    await show({ canManage: false, autoUpEligible: true, onAutoUp: () => {} });
    expect(names()).toEqual(['Compare plans']);
  });

  it('Upgrade calls onUpgrade; an add-on takes the primary place', async () => {
    const onUpgrade = vi.fn();
    const onAdd = vi.fn();
    await show({
      onUpgrade,
      addOn: { label: 'Add Customer-facing screen for $19 a month', onAdd },
    });
    expect(names()).toEqual([
      'Add Customer-facing screen for $19 a month',
      'Upgrade to Season Pass',
      'Compare plans',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Season Pass' }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: /^Add Customer-facing/ }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
