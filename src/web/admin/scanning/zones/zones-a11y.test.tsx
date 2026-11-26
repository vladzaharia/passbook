import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { reachStep } from '../sessions/wizard-test-nav.ts';
import { ACTIVE_ZONES, annex } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const page = (items: unknown[]) => json({ items, nextCursor: null });
const handlers = {
  '/api/v1/scan-zones': (url: URL) =>
    page(url.searchParams.get('archived') === 'true' ? [annex] : ACTIVE_ZONES),
  '/api/v1/scan-setups': () => page([]),
  '/api/v1/scanning-sessions': () => page([]),
  '/api/v1/scan-events': () => page([]),
  '/api/v1/templates/eligible': () => page([]),
};

// jsdom has no layout: width sets the viewport the kit's media queries read, and the theme
// attribute is the one the toggle stamps. Colour contrast is covered by e2e (needs real paint).
const COMBOS = [1440, 820, 390].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => [width, theme] as const),
);

afterEach(() => {
  resetModeForTests();
  delete document.documentElement.dataset.theme;
});

function viewport(width: number, theme: string) {
  document.documentElement.dataset.theme = theme;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe.each(COMBOS)('axe at %i, %s theme', (width, theme) => {
  it('Zones tab, its dialogs and archived list', async () => {
    viewport(width, theme);
    await renderApp('/admin/scanning?tab=zones&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Zones' });
    await user.click(await screen.findByRole('button', { name: 'Show archived (1)' }));
    await screen.findByRole('list', { name: 'Archived zones' });
    expect((await axe(document.body)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'New zone' }));
    const dialog = await screen.findByRole('dialog', { name: 'New zone' });
    expect((await axe(document.body)).violations).toEqual([]);
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Pool');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('switch', { name: 'Track who’s inside' }));
    expect((await axe(document.body)).violations).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await within(dialog).findByRole('heading', { name: 'Check and create' });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('session Access tab with the zones picker open', async () => {
    viewport(width, theme);
    await renderApp('/admin/scanning?new=1&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    await user.type(await within(dialog).findByRole('textbox', { name: 'Session name' }), 'Gate');
    await reachStep(user, dialog, 'Set where it scans');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose zones' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Pool' }));
    expect((await axe(document.body)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await reachStep(user, dialog, 'Set the customer screen');
    expect((await axe(document.body)).violations).toEqual([]);
    expect(within(dialog).getByRole('textbox', { name: 'Welcome' })).toBeInTheDocument();
  });
});
