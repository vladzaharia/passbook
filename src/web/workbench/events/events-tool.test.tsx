import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import {
  CAPTURE,
  type Calls,
  capture,
  delivery,
  eventsHandlers,
  feedEvent,
  HOOK,
  type World,
  wideWindow,
} from './test-fixtures.ts';

beforeEach(() => {
  wideWindow();
});
afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

const world = (): World => ({
  endpoints: [CAPTURE, HOOK],
  events: [
    feedEvent('ev1', { type: 'pass.issued' }),
    feedEvent('ev2', { requestId: 'req-aaaa-bbbb' }),
  ],
  deliveries: {
    ev2: [delivery('we1', 'ev2', 'url'), delivery('wecap', 'ev2', 'capture')],
    we1: [delivery('we1', 'ev2', 'url')],
  },
  captures: [capture('cap1', 'ev2')],
});

async function open(path: string, w = world(), session: 'developer' = 'developer') {
  const [route, hash = ''] = path.split('#');
  history.replaceState(null, '', `${route}${hash ? `#${hash}` : ''}`);
  const calls: Calls[] = [];
  const view = await renderApp(path, { session, handlers: eventsHandlers(w, calls) });
  return { ...view, calls, world: w };
}

const list = () => screen.findByRole('listbox', { name: 'Events' });

describe('Events', () => {
  it('lists the feed newest first, on the token and with no mode header', async () => {
    const { calls } = await open('/workbench/o/sbx/events');
    const box = await list();
    const rows = within(box).getAllByRole('option');
    expect(rows).toHaveLength(2);
    // The ledger reads oldest first; the list shows the newest on top.
    expect(rows[0]).toHaveTextContent('pass.scanned');
    expect(rows[1]).toHaveTextContent('pass.issued');
    const feed = calls.filter((c) => c.path === '/api/v1/events');
    expect(feed.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers.authorization, c.path).toBe('Bearer pbtry_sbx');
      expect(
        Object.keys(c.headers).filter((h) => /mode/i.test(h)),
        c.path,
      ).toEqual([]);
    }
  });

  it('opens an event: where it went, in the shared delivery list, and Open in Console', async () => {
    await open('/workbench/o/sbx/events#ev2');
    const table = await screen.findByRole('table', { name: 'Deliveries of this event' });
    await waitFor(() => expect(within(table).getAllByText('Delivered')).toHaveLength(2));
    expect(within(table).getByText('Capture endpoint')).toBeInTheDocument();
    expect(within(table).getByText('Orders')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open in Console' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/workbench\/o\/sbx\/console\?op=events\.getEventsById&prefill=/);
    const nonce = new URL(href, 'http://x').searchParams.get('prefill');
    expect(JSON.parse(sessionStorage.getItem(`wb-prefill:${nonce}`) ?? '{}')).toEqual({
      op: 'events.getEventsById',
      path: { id: 'ev2' },
    });
    // Ids travel by nonce; a body never rides the URL.
    expect(href).not.toMatch(/body/i);
    expect(screen.getByRole('link', { name: /Request in Logs/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/logs#req-aaaa-bbbb',
    );
  });

  it("?endpoint= opens that endpoint's delivery of the event", async () => {
    const { calls } = await open('/workbench/o/sbx/events?endpoint=we1#ev2');
    const section = await screen.findByRole('region', { name: 'Delivery' });
    expect(await within(section).findByRole('heading', { name: 'Attempts' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/webhook-endpoints/we1/deliveries/ev2')).toBe(true);
  });

  it('?capture= opens the stored request of the event', async () => {
    await open('/workbench/o/sbx/events?capture=cap1#ev2');
    const section = await screen.findByRole('region', { name: 'Captured request' });
    expect(within(section).getByText('200')).toBeInTheDocument();
    expect(within(section).getByRole('tab', { name: 'Verify' })).toBeInTheDocument();
  });

  it('narrows the feed by type and request on the server', async () => {
    const { calls } = await open('/workbench/o/sbx/events?type=pass.issued&request=req-1');
    await list();
    const feed = calls.find((c) => c.path === '/api/v1/events');
    expect(feed?.search).toContain('types=pass.issued');
    expect(feed?.search).toContain('requestId=req-1');
  });

  it('says it is listening when nothing has arrived, with Add endpoint as its one way on', async () => {
    await open('/workbench/o/sbx/events', { ...world(), events: [] });
    expect(await screen.findByText('Listening for events')).toBeInTheDocument();
    const add = screen.getAllByRole('link', { name: 'Add endpoint' });
    expect(add).toHaveLength(1);
    // One wizard: the admin Connections path, back here when it is done.
    expect(add[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/connections/new?source=outbound'),
    );
    expect(add[0]?.getAttribute('href')).toContain('return=%2Fworkbench%2F');
    // Each way on once: the head holds neither while the empty state does.
    expect(screen.getAllByRole('button', { name: 'Send test event' })).toHaveLength(1);
  });
});

describe('Endpoints', () => {
  it('lists the endpoints and opens the selected one with its deliveries', async () => {
    await open('/workbench/o/sbx/events?tab=endpoints#we1');
    const box = await screen.findByRole('listbox', { name: 'Endpoints' });
    expect(within(box).getAllByRole('option')).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'Send test event' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Deliveries' })).toBeInTheDocument();
  });

  it('the capture endpoint lists what it stored, and has no rotate or delete', async () => {
    await open('/workbench/o/sbx/events?tab=endpoints#wecap');
    expect(await screen.findByRole('table', { name: 'Stored requests' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('sends a test event to a paused endpoint, which the API accepts', async () => {
    const user = userEvent.setup();
    const w = { ...world(), endpoints: [CAPTURE, { ...HOOK, status: 'paused' as const }] };
    const { calls } = await open('/workbench/o/sbx/events?tab=endpoints#we1', w);
    const send = await screen.findByRole('button', { name: 'Send test event' });
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/we1/test'))).toBe(true),
    );
  });

  it('pauses and deletes a URL endpoint on the token', async () => {
    const user = userEvent.setup();
    const { calls } = await open('/workbench/o/sbx/events?tab=endpoints#we1');
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'paused' }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    for (const c of calls) expect(c.headers.authorization, c.path).toBe('Bearer pbtry_sbx');
  });
  it('offers Mark seen only while there are events to mark', async () => {
    const summary = { failedDeliveries: 2, listening: true };
    await open('/workbench/o/sbx/events', { ...world(), events: [], summary });
    await screen.findByText('Listening for events');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark seen' })).toBeNull());
  });

  it('keeps Mark seen once events have arrived', async () => {
    await open('/workbench/o/sbx/events', {
      ...world(),
      summary: { failedDeliveries: 2, listening: true },
    });
    await list();
    expect(await screen.findByRole('button', { name: 'Mark seen' })).toBeInTheDocument();
  });
});
