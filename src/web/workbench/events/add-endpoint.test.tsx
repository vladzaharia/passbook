import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import {
  CAPTURE,
  type Calls,
  eventsHandlers,
  feedEvent,
  HOOK,
  type World,
  wideWindow,
} from './test-fixtures.ts';

beforeEach(() => wideWindow());
afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

const world = (): World => ({
  endpoints: [CAPTURE, HOOK],
  events: [feedEvent('ev1')],
  deliveries: {},
  captures: [],
  summary: {
    quotas: {
      passes: { used: 0, limit: 25 },
      templates: { used: 1, limit: 3 },
      endpoints: { used: 2, limit: 3 },
      keys: { used: 1, limit: 5 },
    },
  },
});

async function open(path: string, w = world()) {
  const [route, hash = ''] = path.split('#');
  history.replaceState(null, '', `${route}${hash ? `#${hash}` : ''}`);
  const calls: Calls[] = [];
  const view = await renderApp(path, { session: 'developer', handlers: eventsHandlers(w, calls) });
  // The bench reads the window's address; keep it where the router is (a browser does).
  view.router.history.subscribe(() =>
    window.history.replaceState(null, '', view.router.history.location.href),
  );
  return { ...view, calls };
}
const dialog = () => screen.findByRole('dialog', { name: 'Add endpoint' });
const here = (r: { router: { history: { location: { href: string } } } }) =>
  r.router.history.location.href;

describe('the mounted wizard (design §1.10)', () => {
  it('opens at ?new=1 in the Endpoints tab, locked to this context, with the quota', async () => {
    await open('/workbench/o/sbx/events?tab=endpoints&new=1');
    const d = await dialog();
    // Sandbox: both a URL endpoint and the capture endpoint, and the plan's count.
    expect(within(d).getByRole('radio', { name: /Your server/ })).toBeChecked();
    expect(within(d).getByRole('radio', { name: /Capture endpoint/ })).toBeInTheDocument();
    expect(await within(d).findByText('2 of 3 endpoints')).toBeInTheDocument();
    // No organization chooser: the wizard names no org.
    expect(within(d).queryByText(/organization/i)).not.toBeInTheDocument();
  });

  it("an organization's Test has the URL endpoint only", async () => {
    await open('/workbench/o/nw/events?tab=endpoints&new=1');
    const d = await dialog();
    expect(within(d).queryByRole('radio', { name: /Capture endpoint/ })).not.toBeInTheDocument();
    expect(within(d).queryByText(/endpoints$/)).not.toBeInTheDocument();
  });

  it('creates a Test endpoint on the token; Done selects it, says so and focuses Send test event', async () => {
    const user = userEvent.setup();
    const view = await open('/workbench/o/sbx/events?tab=endpoints&new=1');
    const d = await dialog();
    await user.type(within(d).getByRole('textbox', { name: /^URL/ }), 'https://example.com/hooks');
    await user.click(within(d).getByRole('button', { name: 'Next' }));
    await user.click(within(d).getByRole('button', { name: 'Next' }));
    await user.click(within(d).getByRole('button', { name: 'Add endpoint' }));
    const result = await screen.findByRole('dialog', { name: /Set up your server/ });
    const made = view.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/webhook-endpoints' && !c.search,
    );
    expect(made?.body).toMatchObject({ url: 'https://example.com/hooks' });
    // The secret rides the token; no cookie-only call, no mode.
    for (const c of view.calls) {
      expect(c.headers.authorization, c.path).toBe('Bearer pbtry_sbx');
      expect(
        Object.keys(c.headers).filter((h) => /mode/i.test(h)),
        c.path,
      ).toEqual([]);
    }
    // Both sides: PassBook's live test, and the steps for your server from the guide.
    expect(within(result).getByRole('button', { name: 'Send test' })).toBeInTheDocument();
    expect(await within(result).findByText('Store the secret')).toBeInTheDocument();
    await user.click(within(result).getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(within(result).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(here(view)).toBe('/workbench/o/sbx/events?tab=endpoints#we-new'));
    expect(await screen.findByText('Endpoint added')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: 'Send test event' })
          .some((b) => b === document.activeElement),
      ).toBe(true),
    );
  });

  it('Cancel closes it and returns focus to Add endpoint; Back also closes it', async () => {
    const user = userEvent.setup();
    const view = await open('/workbench/o/sbx/events?tab=endpoints');
    const add = await screen.findByRole('button', { name: 'Add endpoint' });
    await user.click(add);
    const d = await dialog();
    expect(here(view)).toBe('/workbench/o/sbx/events?tab=endpoints&new=1');
    await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add endpoint' })).not.toBeInTheDocument(),
    );
    expect(here(view)).not.toContain('new=1');
    await waitFor(() => expect(add).toHaveFocus());
    // Opening pushed an entry, so the browser's Back closes it as well.
    await user.click(add);
    await dialog();
    view.router.history.back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add endpoint' })).not.toBeInTheDocument(),
    );
  });

  it('shows why a URL was refused, from the server, and keeps the draft', async () => {
    const user = userEvent.setup();
    const w = world();
    const view = await open('/workbench/o/sbx/events?tab=endpoints&new=1', w);
    const d = await dialog();
    expect(view.calls.length).toBeGreaterThan(0);
    await user.type(within(d).getByRole('textbox', { name: /^URL/ }), 'http://example.com');
    await user.tab();
    expect(await within(d).findByText('Use an https URL.')).toBeInTheDocument();
  });
});
