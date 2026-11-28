import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchHandler, json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import {
  appliedResult,
  appOptions,
  factHandlers,
  setupRoute,
  stubDesktop,
} from './test-fixtures.ts';

beforeEach(() => {
  window.scrollTo = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

const start = (preset: string, extra: Record<string, FetchHandler> = {}) =>
  renderApp(`/admin/o/o1/scanning/setup?preset=${preset}`, {
    ...appOptions,
    handlers: { ...factHandlers, '/api/v1/scanning-sessions/setup': setupRoute(), ...extra },
  });
const summary = () => screen.findByRole('complementary', { name: 'Door' });
const next = (user: ReturnType<typeof userEvent.setup>, name = 'Next') =>
  user.click(screen.getByRole('button', { name }));

describe('Set up scanning', () => {
  it('asks which setup first when the URL names none', async () => {
    await renderApp('/admin/o/o1/scanning/setup', { ...appOptions, handlers: factHandlers });
    expect(await screen.findByRole('link', { name: /Front desk/ })).toHaveAttribute(
      'href',
      expect.stringContaining('preset=front_desk'),
    );
    expect(screen.getByRole('link', { name: /Event night/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Several areas/ })).toBeInTheDocument();
  });

  it('Front desk pre-fills the door and walks the steps, filling the summary in', async () => {
    stubDesktop();
    const user = userEvent.setup();
    await start('front_desk');
    expect(await screen.findByRole('textbox', { name: /Door name/ })).toHaveValue('Front desk');
    const aside = await summary();
    // Unanswered lines read dimmed.
    expect(within(aside).getByText('Who gets in').closest('li')).toHaveAttribute('data-dim');
    await next(user);
    // Who gets in: Next waits for a pass type.
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Pick a pass type or an event.')).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'Monthly' }));
    expect(within(await summary()).getByText('Monthly')).toBeInTheDocument();
    await next(user);
    // When: set hours is explicit; nothing is applied until it is typed.
    await user.click(await screen.findByRole('radio', { name: 'Set hours' }));
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByLabelText('Every day from'), '06:00');
    await user.type(screen.getByLabelText('To'), '22:00');
    await next(user);
    // Who scans: staff by PIN came with the preset.
    expect(await screen.findByRole('radio', { name: 'Staff sign in with a PIN' })).toBeChecked();
    await next(user);
    // Devices: a tablet and a phone, named like the server will name them.
    expect(await screen.findByText('Front desk 1')).toBeInTheDocument();
    expect(screen.getByText('Front desk 2')).toBeInTheDocument();
    expect(within(await summary()).getByText('2 devices')).toBeInTheDocument();
  });

  it('shows the area tree for Several areas', async () => {
    const user = userEvent.setup();
    await start('venue');
    expect(await screen.findByRole('textbox', { name: /Door name/ })).toHaveValue('Main door');
    expect(screen.getByDisplayValue('Gym')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add inside' }));
    expect(screen.getAllByPlaceholderText('Area')).toHaveLength(2);
  });

  it('skips When for an event door', async () => {
    const user = userEvent.setup();
    await start('event_night');
    await screen.findByRole('textbox', { name: /Door name/ });
    await next(user);
    await user.click(await screen.findByRole('checkbox', { name: 'Monthly' }));
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Saturday gala');
    await user.type(screen.getByLabelText(/Date/), '2026-12-05');
    await user.type(screen.getByLabelText(/Opens/), '19:00');
    await user.type(screen.getByLabelText(/Closes/), '23:30');
    await user.click(screen.getByRole('button', { name: 'Save event' }));
    await next(user);
    // Straight from Who gets in to Who scans.
    expect(
      await screen.findByRole('radio', { name: 'Anyone with the device' }),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-state="skipped"]')?.closest('li')).toHaveTextContent(
      'When',
    );
  });

  it('Review shows the server plan, and a fix edits the answers', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await start('front_desk');
    await screen.findByRole('textbox', { name: /Door name/ });
    // Count people inside, with only a Door-role person to sign in.
    await user.click(screen.getByRole('switch', { name: "Count who's inside" }));
    await user.type(screen.getByRole('textbox', { name: /Area/ }), 'Gym');
    await user.type(screen.getByRole('spinbutton', { name: /Max inside/ }), '60');
    await next(user);
    await user.click(await screen.findByRole('checkbox', { name: 'Monthly' }));
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Add person' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Sam Ortiz');
    await next(user);
    await next(user, 'Review');
    // No exit would be a warning; the planner derives In and out, so the warning is the Manager.
    const fix = await screen.findByRole('button', { name: 'Make Sam Ortiz a Manager' });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/scanning-sessions/setup?dryRun=true'),
      ),
    ).toBe(true);
    await user.click(fix);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Make Sam Ortiz a Manager' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Set up' })).toBeEnabled();
    // The time zone is shown once, here.
    expect(screen.getByRole('region', { name: 'Time zone' })).toBeInTheDocument();
  });

  it('uses the server dry run when the route exists', async () => {
    const user = userEvent.setup();
    const serverPlan = {
      mode: 'live',
      timeZone: 'UTC',
      preset: 'event_night',
      zones: [],
      events: [],
      staff: [],
      sessions: [
        {
          ref: 'door-1',
          name: 'Doors',
          timeZone: 'UTC',
          accepts: null,
          zones: [],
          hours: null,
          settings: {},
          devices: [
            {
              ref: 'door-1-1',
              name: 'Doors 1',
              surface: 'auto',
              overrides: {},
              role: 'scan',
            },
          ],
        },
      ],
      checks: [
        {
          code: 'EVENT_NO_PASSES',
          level: 'info',
          message: 'eventNoPasses',
          params: { event: 'Saturday gala' },
        },
      ],
    };
    await start('event_night', {
      '/api/v1/scanning-sessions/setup': () => json(serverPlan),
    });
    await screen.findByRole('textbox', { name: /Door name/ });
    await next(user);
    await user.click(await screen.findByRole('switch', { name: 'Any pass type' }));
    await next(user);
    await next(user);
    await next(user, 'Next');
    await next(user, 'Review');
    expect(
      await screen.findByText(
        'Saturday gala has no passes yet. Issue passes before the doors open.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the error state, not a crash, when apply fails with a 404', async () => {
    const user = userEvent.setup();
    await start('event_night', {
      '/api/v1/scanning-sessions/setup': setupRoute(() => problem(404, 'not_found', 'Not found.')),
    });
    await screen.findByRole('textbox', { name: /Door name/ });
    await next(user);
    await user.click(await screen.findByRole('switch', { name: 'Any pass type' }));
    await next(user);
    await next(user);
    await next(user);
    await next(user, 'Review');
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByText(/Could not set up scanning/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('applies with an idempotency key and opens Done', async () => {
    const user = userEvent.setup();
    const seen: { key: string | null; body: unknown }[] = [];
    await start('event_night', {
      '/api/v1/scanning-sessions/setup': setupRoute((_url, i) => {
        seen.push({
          key: new Headers(i?.headers).get('Idempotency-Key'),
          body: JSON.parse(String(i?.body)),
        });
        return json(appliedResult());
      }),
    });
    await screen.findByRole('textbox', { name: /Door name/ });
    await next(user);
    await user.click(await screen.findByRole('switch', { name: 'Any pass type' }));
    await next(user);
    await next(user);
    await next(user);
    await next(user, 'Review');
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('heading', { name: 'Front desk is ready' })).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toMatch(/[0-9a-f-]{36}/);
    expect(seen[0]?.body).toMatchObject({ orgId: 'o1', preset: 'event_night' });
  });
});
