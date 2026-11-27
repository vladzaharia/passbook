import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';

const quiet = { '/api/v1/passes': () => json({ items: [], nextCursor: null }) };
const a = membershipFixture('o1', { orgName: 'Northwind' });
const b = membershipFixture('o2', { orgName: 'Harbor' });
const noPasses = membershipFixture('o3', { orgName: 'Rain City', capabilities: ['org:read'] });

async function openSwitcher(path: string, memberships: ReturnType<typeof membershipFixture>[]) {
  const user = userEvent.setup();
  const app = await renderApp(path, { session: 'user', memberships, handlers: quiet });
  await user.click(await screen.findByRole('combobox', { name: /^Scope:/ }));
  return { user, ...app };
}

describe('the All organizations scope', () => {
  it('is offered with two readable organizations and opens its Passes page', async () => {
    const { user, router } = await openSwitcher('/admin/o/o1/passes', [a, b]);
    await user.click(await screen.findByRole('option', { name: 'All organizations' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/all/passes'));
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Passes']);
    expect(screen.getByRole('combobox', { name: 'Scope: All organizations' })).toBeInTheDocument();
  });

  it('is hidden with one readable organization', async () => {
    await openSwitcher('/admin/o/o1/passes', [a, noPasses]);
    expect(await screen.findByRole('option', { name: 'Northwind' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'All organizations' })).toBeNull();
  });

  it('leaves for an organization on the same section', async () => {
    const { user, router } = await openSwitcher('/admin/all/passes', [a, b]);
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/o/o2/passes'));
  });

  it('sends the person to the one organization left when access drops below two', async () => {
    const { router } = await renderApp('/admin/all/passes', {
      session: 'user',
      memberships: [a, noPasses],
      handlers: quiet,
    });
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/admin/all/passes'));
    expect(router.state.location.pathname.startsWith('/admin/o/')).toBe(true);
  });

  it('opens the bare /admin/all on Passes', async () => {
    const { router } = await renderApp('/admin/all', {
      session: 'user',
      memberships: [a, b],
      handlers: quiet,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/all/passes'));
  });
});
