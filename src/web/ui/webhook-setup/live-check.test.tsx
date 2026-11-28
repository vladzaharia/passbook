import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { LiveCheck } from './index.ts';
import { arrival, TOPICS } from './test-support.test-support.tsx';
import type { Arrival } from './types.ts';

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  fireEvent(document, new Event('visibilitychange'));
};

function listen(rows: () => Arrival[], over: Record<string, unknown> = {}) {
  const load = vi.fn(async (_since: number, etag: string | undefined) =>
    etag === 'e1' ? null : { rows: rows(), etag: 'e1' },
  );
  const onChange = vi.fn();
  const view = render(
    <LiveCheck
      mode="listen"
      provider="Shopify"
      load={load}
      since={0}
      topics={TOPICS}
      onChange={onChange}
      {...over}
    />,
  );
  return { load, onChange, ...view };
}
const said = () => document.querySelector('[aria-live="polite"]')?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('LiveCheck listen', () => {
  it('starts by listening and says so once', async () => {
    listen(() => []);
    await tick(0);
    expect(screen.getByRole('heading', { name: 'Listening · nothing yet' })).toBeInTheDocument();
    expect(said()).toBe('Listening for Shopify.');
  });

  it('passes axe while listening and after a bad signature', async () => {
    vi.useRealTimers();
    const rows = [arrival({ outcome: 'rejected', reason: 'signature_mismatch', topic: null })];
    const { container, unmount } = listen(() => rows);
    await screen.findByRole('heading', { name: "Signature didn't match" });
    expect((await axe(container)).violations).toEqual([]);
    unmount();
  });

  it('polls every 2 s while visible, 15 s while hidden, and at once on return, with the etag', async () => {
    const { load } = listen(() => []);
    await tick(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(0, undefined);
    await tick(2000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(0, 'e1');
    setVisibility('hidden');
    await tick(2000);
    const hidden = load.mock.calls.length;
    await tick(14_000);
    expect(load).toHaveBeenCalledTimes(hidden);
    await tick(1000);
    expect(load).toHaveBeenCalledTimes(hidden + 1);
    setVisibility('visible');
    await tick(0);
    expect(load).toHaveBeenCalledTimes(hidden + 2);
  });

  it('catches a signed delivery: ticks the topic, says it, enables the host and offers what it made', async () => {
    const rows: Arrival[] = [];
    const onInspect = vi.fn();
    const { onChange, load } = listen(() => rows, { onInspect });
    await tick(0);
    rows.push(arrival({ topic: 'orders/create' }));
    load.mockImplementation(async () => ({ rows: [...rows], etag: 'e2' }));
    await tick(2000);
    expect(screen.getByRole('heading', { name: 'Signed delivery seen' })).toBeInTheDocument();
    expect(said()).toBe('Delivery from Shopify, signed correctly.');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'signed', seen: ['orders/create'] }),
    );
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check what it made' }));
    expect(onInspect).toHaveBeenCalledTimes(1);
  });

  it('counts a sample as a pass and says what it proves', async () => {
    listen(() => [arrival({ outcome: 'ignored', reason: 'stale', topic: 'orders/create' })]);
    await tick(0);
    expect(
      screen.getByText('Samples prove the setup. Real records issue passes.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check what it made' })).toBeNull();
  });

  it('keeps listening after a bad signature, says what to do, and lets a later pass win', async () => {
    const rows = [arrival({ outcome: 'rejected', reason: 'signature_mismatch', topic: null })];
    const actions = { replaceSecret: vi.fn() };
    const { load } = listen(() => rows, { actions });
    await tick(0);
    expect(screen.getByRole('heading', { name: "Signature didn't match" })).toBeInTheDocument();
    expect(said()).toBe("A delivery arrived but its signature didn't match.");
    fireEvent.click(screen.getByRole('button', { name: 'Replace secret' }));
    expect(actions.replaceSecret).toHaveBeenCalled();
    load.mockImplementation(async () => ({ rows: [...rows, arrival()], etag: 'e3' }));
    await tick(2000);
    expect(screen.getByRole('heading', { name: 'Signed delivery seen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace secret' })).toBeNull();
  });

  it('opens the troubleshooting at 3 minutes with nothing, and goes on listening', async () => {
    const { load } = listen(() => []);
    await tick(3 * 60_000 - 1000);
    expect(screen.queryByText('Nothing arrived')).toBeNull();
    await tick(1000);
    expect(screen.getByText('Nothing arrived')).toBeInTheDocument();
    expect(said()).toBe('Nothing has arrived yet.');
    const calls = load.mock.calls.length;
    await tick(2000);
    expect(load.mock.calls.length).toBeGreaterThan(calls);
  });

  it('uses the recipe line for an empty ledger', async () => {
    listen(() => [], { recipeFix: { none: 'Check both webhooks say Active.' } });
    await tick(3 * 60_000);
    expect(screen.getByText('Check both webhooks say Active.')).toBeInTheDocument();
  });

  it('pauses polling at 15 minutes, says so, and Resume starts a fresh run', async () => {
    const { load, onChange } = listen(() => []);
    await tick(15 * 60_000);
    expect(screen.getByRole('heading', { name: 'Paused listening' })).toBeInTheDocument();
    expect(said()).toBe('Paused.');
    // The strip elsewhere says what the panel says.
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ head: 'Paused listening' }),
    );
    const paused = load.mock.calls.length;
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(paused);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await tick(0);
    expect(load.mock.calls.length).toBe(paused + 1);
    expect(screen.getByRole('heading', { name: 'Listening · nothing yet' })).toBeInTheDocument();
  });

  it('shows a ledger error inline and resumes on Try again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ rows: [] });
    render(<LiveCheck mode="listen" provider="Shopify" load={load} since={0} />);
    await tick(0);
    expect(screen.getByText(/Could not load deliveries/)).toBeInTheDocument();
    expect(said()).toBe("Couldn't check for deliveries.");
    await tick(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await tick(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Listening · nothing yet' })).toBeInTheDocument();
  });

  it('reads the ledger from since, and lists what was seen in the given zone', async () => {
    const at = Date.UTC(2026, 10, 25, 20, 30);
    const { load } = listen(
      () => [
        arrival({ receivedAt: at, outcome: 'ignored', reason: 'unknown_type', topic: 'other' }),
      ],
      {
        since: 123,
        zone: 'America/Los_Angeles',
      },
    );
    await tick(0);
    expect(load).toHaveBeenCalledWith(123, undefined);
    expect(screen.getByRole('list', { name: 'Seen' })).toHaveTextContent('12:30');
    expect(screen.getByRole('list', { name: 'Seen' })).toHaveTextContent('Topic not used');
  });
});

describe('LiveCheck send', () => {
  const ok = { ok: true, status: 200, durationMs: 140 };
  it('sends, says delivered with the timing, and offers Send again', async () => {
    vi.useRealTimers();
    const send = vi.fn(async () => ok);
    const onChange = vi.fn();
    const { container } = render(
      <LiveCheck mode="send" send={send} host="api.example.com" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Your server answered 200 in 140 ms.')).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({ phase: 'delivered', result: ok });
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument();
    await waitFor(() => expect(said()).toBe('Delivered.'));
    expect((await axe(container)).violations).toEqual([]);
  });

  it('diagnoses a refused test, with the request id to copy', async () => {
    vi.useRealTimers();
    const send = vi.fn(async () => ({
      ok: false,
      status: 502,
      durationMs: 90,
      requestId: 'req_123',
    }));
    render(<LiveCheck mode="send" send={send} host="api.example.com" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Server error')).toBeInTheDocument();
    await waitFor(() => expect(said()).toBe('Failed. Server error.'));
    expect(screen.getByRole('button', { name: 'Copy request id' })).toBeInTheDocument();
  });

  it('shows a call that never reached the server as a plain message, and hides Send without permission', async () => {
    vi.useRealTimers();
    const send = vi.fn(async () => Promise.reject(new Error('offline')));
    const { rerender } = render(<LiveCheck mode="send" send={send} host="h" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/offline|Could not|went wrong/i)).toBeInTheDocument();
    rerender(<LiveCheck mode="send" send={send} host="h" canSend={false} />);
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });
});
