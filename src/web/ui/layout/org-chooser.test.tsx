import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';

const KEY = 'passbook-admin-scope';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', {
  orgName: 'Harbor',
  orgSlug: 'harbor',
  roles: ['template_author', 'pass_operator', 'template_reviewer'],
});
const personal = membershipFixture('p1', { orgName: 'Personal', personal: true });
const reader = membershipFixture('o3', {
  orgName: 'Rain City',
  roles: ['read_only'],
  capabilities: ['org:read', 'templates:read'],
});
const sandbox = membershipFixture('s1', { orgName: 'Ada sandbox', testOnly: true });
const many = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo'].map((name, i) =>
  membershipFixture(`t${i}`, { orgName: name, orgSlug: name.toLowerCase() }),
);
const quiet = { '/api/v1/passes': () => json({ items: [], nextCursor: null }) };

const cards = () =>
  within(screen.getByRole('list', { name: 'Organizations' })).getAllByRole('link');

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('org chooser', () => {
  it('shows the organizations as cards: last used first, then personal, named by the org', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'org:o2' }));
    await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: [northwind, harbor, personal, sandbox],
      handlers: quiet,
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization', level: 1 }),
    ).toBeInTheDocument();
    const links = cards();
    // A developer sandbox is never offered.
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/admin/o/o2/passes',
      '/admin/o/p1/passes',
      '/admin/o/o1/passes',
    ]);
    expect(screen.getByRole('link', { name: 'Harbor' })).toHaveAccessibleDescription(
      'Template author, Pass operator +1 Last used',
    );
    expect(screen.getByRole('link', { name: 'Northwind' })).toHaveAccessibleDescription(
      'Organization admin',
    );
    expect(screen.queryByRole('link', { name: 'Ada sandbox' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens the section asked for, or the first one the role opens', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: [northwind, reader],
      handlers: quiet,
    });
    const rain = await screen.findByRole('link', { name: 'Rain City' });
    // Rain City reads templates only: Passes is not there, so its first section opens.
    expect(rain.getAttribute('href')).not.toBe('/admin/o/o3/passes');
    expect(rain.getAttribute('href')).toMatch(/^\/admin\/o\/o3\//);
    await user.click(screen.getByRole('link', { name: 'Northwind' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/o/o1/passes'));
  });

  it('filters past six organizations; Enter opens the first match, nothing matching says so', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: many,
      handlers: quiet,
    });
    const find = await screen.findByRole('searchbox', { name: 'Find an organization' });
    await user.type(find, 'ce');
    expect(cards().map((l) => l.textContent)).toEqual(['Cedar']);
    expect(screen.getByText('1 organization')).toHaveAttribute('role', 'status');
    await user.clear(find);
    await user.type(find, 'zzz');
    expect(screen.getByText('No organizations match')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Organizations' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cards()).toHaveLength(7);
    await user.type(find, 'gink{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/o/t6/passes'));
  });

  it('moves through the cards with the arrow keys, Home and End, and back up to the filter', async () => {
    const user = userEvent.setup();
    await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: many,
      handlers: quiet,
    });
    const find = await screen.findByRole('searchbox', { name: 'Find an organization' });
    await user.click(find);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Alder' })).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('link', { name: 'Cedar' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('link', { name: 'Birch' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('link', { name: 'Ginkgo' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('link', { name: 'Alder' })).toHaveFocus();
    // One row in jsdom (no layout): up leaves the grid for the filter.
    await user.keyboard('{ArrowUp}');
    expect(find).toHaveFocus();
  });

  it('moves down a column to the card under it, or the last card of a shorter row', async () => {
    const user = userEvent.setup();
    await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: many,
      handlers: quiet,
    });
    await screen.findByRole('link', { name: 'Alder' });
    // Three across: rows of 3, 3 and 1.
    for (const [i, link] of cards().entries()) {
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({
        top: Math.floor(i / 3) * 200,
      } as DOMRect);
    }
    screen.getByRole('link', { name: 'Birch' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Elm' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Ginkgo' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('link', { name: 'Dogwood' })).toHaveFocus();
  });

  it('says there are none, and gives a platform admin the way back to the platform', async () => {
    await renderApp('/admin?next=/passes', {
      session: 'admin',
      memberships: [sandbox],
      handlers: quiet,
    });
    expect(
      await screen.findByRole('heading', { name: 'No organizations', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Platform' })).toHaveAttribute(
      'href',
      '/admin/platform',
    );
    expect(screen.queryByText('Ask an organization admin to invite you.')).toBeNull();
  });

  it('asks a member with none to be invited, with no platform card', async () => {
    // A sandbox membership lets the console open; the chooser offers no sandbox.
    await renderApp('/admin?next=/passes', {
      session: 'user',
      memberships: [sandbox],
      handlers: quiet,
    });
    expect(
      await screen.findByRole('heading', { name: 'No organizations', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Ask an organization admin to invite you.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform' })).toBeNull();
    expect(document.querySelector('main [data-buddy]')).toHaveAttribute('data-scene', 'inspect');
  });

  it('lists the platform with the organizations for a platform admin', async () => {
    await renderApp('/admin?next=/passes', {
      session: 'admin',
      memberships: [northwind, harbor],
      handlers: quiet,
    });
    await screen.findByRole('heading', { name: 'Choose an organization', level: 1 });
    expect(cards().map((l) => l.getAttribute('href'))).toEqual([
      '/admin/platform',
      '/admin/o/o1/passes',
      '/admin/o/o2/passes',
    ]);
    // The buddy points at the badges.
    expect(document.querySelector('main [data-buddy]')).toHaveAttribute('data-scene', 'nudge');
  });
});
