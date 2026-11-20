import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { ApiError } from '../../lib/errors.ts';
import { call, fakeRollCall, person, T0 } from './roll-call-fake.test-support.ts';
import { filterPeople, type QueuedMark, withQueue } from './roll-call-model.ts';
import { RollCallPanel } from './roll-call-panel.tsx';
import { useRollCall } from './use-roll-call.ts';

const connect = vi.fn(() => ({ close: vi.fn() }));
type Nudge = (n: { kind: 'rollCall'; id: string; rev: number; ended: boolean }) => void;

function setup(
  start = call([person(0), person(1), person(2)]),
  online = true,
  store?: ReturnType<typeof memoryStore>,
) {
  const port = fakeRollCall(start);
  const view = renderHook(
    ({ on }: { on: boolean }) =>
      useRollCall({
        port,
        enabled: true,
        online: on,
        by: '',
        connect: connect as never,
        ...(store ? { store } : {}),
      }),
    { initialProps: { on: online } },
  );
  return { port, ...view };
}

function Panel({ hook, online = true }: { hook: ReturnType<typeof setup>; online?: boolean }) {
  return (
    <RollCallPanel
      roll={hook.result.current}
      online={online}
      now={T0 + 12 * 60_000}
      onEnd={vi.fn()}
      onPrint={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  connect.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('roll call model', () => {
  it('lays an unsynced tap over the call, and a newer server mark beats an older tap', () => {
    const base = call([
      person(0),
      person(1, { mark: { status: 'out', by: 'Sam K.', at: T0 + 5000 } }),
    ]);
    const shown = withQueue(
      base,
      [
        { callId: call([]).id, passId: person(0).passId, status: 'present', at: T0 + 1000 },
        { callId: call([]).id, passId: person(1).passId, status: 'present', at: T0 + 1000 },
      ],
      '',
    );
    expect(shown.people.find((p) => p.passId === person(0).passId)?.mark?.status).toBe('present');
    expect(shown.people.find((p) => p.passId === person(1).passId)?.mark?.status).toBe('out');
    expect(shown.counts).toMatchObject({ present: 1, out: 1, unconfirmed: 0 });
  });
  it('filters not confirmed, confirmed and not confirmed out', () => {
    const people = [
      person(0),
      person(1, { mark: { status: 'present', by: '', at: T0 } }),
      person(2, { presence: 'lapsed', notConfirmedOut: true }),
    ];
    expect(filterPeople(people, 'open')).toHaveLength(2);
    expect(filterPeople(people, 'done')).toHaveLength(1);
    expect(filterPeople(people, 'lapsed').map((p) => p.passId)).toEqual([person(2).passId]);
  });
});

const memoryStore = (initial?: QueuedMark[]) => {
  const data = new Map<string, QueuedMark[]>(initial ? [['roll-call-queue', initial]] : []);
  return {
    data,
    set: async (k: string, v: QueuedMark[]) => void data.set(k, v),
    get: async (k: string) => data.get(k),
    all: async () => [...data.values()],
    clear: async () => data.clear(),
  };
};

describe('useRollCall: a refused take-back', () => {
  it('drops the tap, tells the desk, and keeps the Out the server holds', async () => {
    const out = { status: 'out' as const, by: 'Sam K.', at: T0 };
    const refused = vi.fn();
    const port = fakeRollCall(call([person(0, { mark: out })]));
    port.fail = new ApiError({ status: 409, code: 'ROLL_CALL_SCANNED_SINCE' });
    const h = renderHook(() =>
      useRollCall({
        port,
        enabled: true,
        online: true,
        by: '',
        connect: connect as never,
        onRefused: refused,
      }),
    );
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    act(() => h.result.current.mark(person(0).passId, 'none'));
    await waitFor(() => expect(refused).toHaveBeenCalled());
    expect(h.result.current.pending).toBe(0);
    expect(h.result.current.call?.people[0]?.mark?.status).toBe('out');
  });
});

describe('useRollCall: queue identity, clock and storage', () => {
  it('stamps taps with the server-corrected time', async () => {
    const h = setup(call([person(0)], { serverNow: Date.now() + 600_000 }));
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    const before = Date.now();
    act(() => h.result.current.mark(person(0).passId, 'present'));
    await waitFor(() => expect(h.port.calls.marks).toHaveLength(1));
    const sent = h.port.calls.marks[0]?.marks[0] as { at: number };
    expect(sent.at).toBeGreaterThanOrEqual(before + 590_000);
  });

  it('never sends a tap queued for an earlier call to a new one', async () => {
    const stale: QueuedMark = {
      callId: 'an-earlier-call',
      passId: person(0).passId,
      status: 'present',
      at: T0,
    };
    const h = setup(call([person(0)]), true, memoryStore([stale]));
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.port.calls.marks).toHaveLength(0);
  });

  it('keeps unsent taps across a reload, and the store is wiped by the scanner wipe', async () => {
    const store = memoryStore();
    const first = setup(call([person(0)]), false, store);
    first.port.server = call([person(0)]);
    await act(async () => first.rerender({ on: true }));
    await waitFor(() => expect(first.result.current.call).not.toBeNull());
    first.rerender({ on: false });
    act(() => first.result.current.mark(person(0).passId, 'present'));
    await waitFor(() => expect(store.data.get('roll-call-queue')).toHaveLength(1));
    first.unmount();
    const again = setup(call([person(0)]), false, store);
    await waitFor(() => expect(again.result.current.pending).toBe(1));
    await store.clear();
    expect(store.data.size).toBe(0);
  });
});

describe('useRollCall', () => {
  it('reads the open call, and a nudge from the hub reads it again', async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.call?.counts.total).toBe(3));
    const onNudge = (connect.mock.calls[0] as unknown as [{ onNudge: Nudge }])[0].onNudge;
    h.port.server = call([person(0), person(1)], { rev: 4 });
    await act(async () => onNudge({ kind: 'rollCall', id: 'x', rev: 4, ended: false }));
    await waitFor(() => expect(h.result.current.call?.counts.total).toBe(2));
  });

  it('shows a tap at once and sends it; a lower revision never replaces a higher one', async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    act(() => h.result.current.mark(person(0).passId, 'present'));
    expect(h.result.current.call?.counts.present).toBe(1);
    await waitFor(() => expect(h.port.calls.marks).toHaveLength(1));
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.result.current.call?.rev).toBe(2);
  });

  it('keeps taps while offline and sends them together when the connection returns', async () => {
    const h = setup(undefined, false);
    h.port.server = call([person(0), person(1), person(2)]);
    await act(async () => {
      h.rerender({ on: true });
    });
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    h.rerender({ on: false });
    act(() => h.result.current.mark(person(0).passId, 'present'));
    act(() => h.result.current.mark(person(1).passId, 'out'));
    expect(h.result.current.pending).toBe(2);
    expect(h.port.calls.marks).toHaveLength(0);
    h.rerender({ on: true });
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.port.calls.marks[0]?.marks).toHaveLength(2);
    expect(h.result.current.call?.counts).toMatchObject({ present: 1, out: 1 });
  });

  it('drops the queue when the call ended under it', async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    h.port.fail = new ApiError({ status: 409, code: 'ROLL_CALL_ENDED' });
    h.port.server = null;
    act(() => h.result.current.mark(person(0).passId, 'present'));
    await waitFor(() => expect(h.result.current.call).toBeNull());
    expect(h.result.current.pending).toBe(0);
  });
});

describe('RollCallPanel', () => {
  it('shows progress, sorts the unconfirmed first, and marks Safe and Out', async () => {
    const h = setup(
      call([
        person(0, { mark: { status: 'present', by: 'Sam K.', at: T0 } }),
        person(1),
        person(2),
      ]),
    );
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    const { rerender } = render(<Panel hook={h} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('1 of 3 confirmed')).toBeInTheDocument();
    expect(screen.getByText(/by Sam K\./)).toBeInTheDocument();
    const rows = within(screen.getByTestId('roll-call-list')).getAllByTestId('roll-call-row');
    expect(rows[2]).toHaveTextContent('by Sam K.');
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: /is safe/ }));
    rerender(<Panel hook={h} />);
    await waitFor(() => expect(h.port.calls.marks).toHaveLength(1));
    expect(h.port.calls.marks[0]?.marks[0]).toMatchObject({ status: 'present' });
  });

  it('lists a stay the clock closed under Not confirmed out until someone confirms it', async () => {
    const lapsed = person(1, { presence: 'lapsed', notConfirmedOut: true });
    const h = setup(call([person(0), lapsed]));
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    render(<Panel hook={h} />);
    const filter = screen.getByRole('button', { name: 'Not confirmed out 1' });
    fireEvent.click(filter);
    const rows = screen.getAllByTestId('roll-call-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Not confirmed out');
  });

  it('says so when everyone is confirmed, and has no accessibility violations', async () => {
    const done = { status: 'present' as const, by: 'Sam K.', at: T0 };
    const h = setup(call([person(0, { mark: done }), person(1, { mark: done })]));
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    const { container } = render(<Panel hook={h} />);
    expect(screen.getByText('Everyone is confirmed')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows the offline count and the arrived-after-start flag', async () => {
    const h = setup(call([person(0), person(1, { late: true })]), false);
    h.port.server = call([person(0), person(1, { late: true })]);
    await act(async () => h.rerender({ on: true }));
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    h.rerender({ on: false });
    act(() => h.result.current.mark(person(0).passId, 'present'));
    render(<Panel hook={h} online={false} />);
    expect(screen.getByText('Offline · 1 to sync')).toBeInTheDocument();
    expect(screen.getByText('Arrived after start')).toBeInTheDocument();
  });
});
