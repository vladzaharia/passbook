import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '../../../lib/mode.ts';
import { renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, endpoint, HOUR, hooks, manager, NOW, reader } from './test-fixtures.ts';

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

const open = (path: string, calls: Calls[], state = { endpoints: [endpoint()] }, as = manager) =>
  renderApp(path, {
    session: 'admin',
    memberships: [as],
    selectedOrg: 'org1',
    handlers: hooks(calls, state),
  });

describe.each(COMBOS)('axe at %i, %s theme', (width, theme) => {
  it('list: endpoints, then the empty state', async () => {
    viewport(width, theme);
    const calls: Calls[] = [];
    const state = {
      endpoints: [
        endpoint({ id: 'a' }),
        endpoint({ id: 'b', failingSince: NOW - 3 * HOUR }),
        endpoint({ id: 'c', status: 'paused' }),
        endpoint({ id: 'd', status: 'disabled' }),
      ],
    };
    const view = await open('/admin/connections?tab=webhooks', calls, state);
    await screen.findByRole('table', { name: 'Webhook endpoints' });
    expect((await axe(document.body)).violations).toEqual([]);
    view.unmount();
    await open('/admin/connections?tab=webhooks', [], { endpoints: [] });
    await screen.findByText('No webhooks');
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('new endpoint form and the created step', async () => {
    viewport(width, theme);
    const user = userEvent.setup();
    await open('/admin/connections/webhooks/new', []);
    await user.type(
      await screen.findByRole('textbox', { name: /URL/ }),
      'https://hooks.example.com/x',
    );
    expect((await axe(document.body)).violations).toEqual([]);
    for (const step of ['Choose events', 'Review']) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByRole('heading', { name: step });
      expect((await axe(document.body)).violations).toEqual([]);
    }
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByRole('heading', { name: 'Copy the secret' });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('detail with its sheet and dialogs', async () => {
    viewport(width, theme);
    const user = userEvent.setup();
    await open('/admin/connections/webhooks/we1?tab=deliveries', [], {
      endpoints: [endpoint({ status: 'disabled', failingSince: NOW - 80 * HOUR, disabledAt: NOW })],
    });
    await screen.findByRole('table', { name: 'Deliveries' });
    expect((await axe(document.body)).violations).toEqual([]);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await within(sheet).findByText('First send: HTTP 503');
    expect((await axe(sheet)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    const replay = await screen.findByRole('dialog', { name: 'Replay deliveries' });
    expect((await axe(replay)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate secret' }));
    expect(
      (await axe(await screen.findByRole('dialog', { name: 'Rotate secret' }))).violations,
    ).toEqual([]);
  });

  it('detail as a reader', async () => {
    viewport(width, theme);
    await open(
      '/admin/connections/webhooks/we1?tab=deliveries',
      [],
      { endpoints: [endpoint({ url: null })] },
      reader,
    );
    await screen.findByRole('table', { name: 'Deliveries' });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
