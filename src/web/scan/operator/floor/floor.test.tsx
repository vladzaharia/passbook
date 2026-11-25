import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { ThemeProvider } from '../../../lib/theme.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { sessionFixture } from '../../boot/session.test-support.ts';
import { WedgeFieldsContext } from '../../input/wedge-field.tsx';
import { WedgeFields } from '../../input/wedge-source.ts';
import { fixtureCounts, fixtureOutcome } from '../../machine/fixture-data.test-support.ts';
import { states } from '../../machine/fixtures.test-support.ts';
import { fakeDeps } from '../../machine/store.test-support.ts';
import { createScanStore } from '../../machine/store.ts';
import { ScanStoreContext } from '../../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import { OperatorWorkspace } from '../workspace/workspace.tsx';

const NOW = Date.now();
const id = (n: number) => `01900000-0000-7000-8000-0000000007${n.toString().padStart(2, '0')}`;

const person = (n: number, name: string, over: Partial<RollCallPerson> = {}): RollCallPerson => ({
  passId: id(n),
  holder: name,
  plan: null,
  host: null,
  place: 'z1',
  placeName: 'Gym floor',
  since: NOW - n * 60_000,
  basis: 'in_now',
  presence: 'in',
  late: false,
  mark: null,
  notConfirmedOut: false,
  ...over,
});

function server(): RollCall {
  return {
    id: id(90),
    placeNames: ['Gym floor'],
    startedAt: NOW - 60_000,
    startedBy: 'Ana R.',
    endedAt: null,
    endedBy: null,
    rev: 1,
    serverNow: NOW,
    counts: {
      total: 3,
      present: 0,
      out: 0,
      unconfirmed: 3,
      notConfirmedOut: 0,
      late: 0,
      inNow: 3,
      tappedIn: 0,
    },
    people: [person(3, 'Ada Okafor'), person(2, 'Bo Chen'), person(1, 'Cy Dahl')],
  };
}

function setup(over: { role?: 'door' | 'desk'; roll?: boolean } = {}) {
  const role = over.role ?? 'desk';
  let current = over.roll === false ? null : server();
  const marks = vi.fn();
  const api = {
    activity: async () => ({ items: [] }),
    lookup: async () => ({ items: [], more: false }),
    resolve: async () => fixtureOutcome('refused', 'not_found'),
    inside: async () => ({
      places: [{ place: 'z1', name: 'Gym floor', inNow: 3, capacity: 10, rev: 1 }],
      items: [],
      total: 3,
      nextCursor: null,
      asOf: NOW,
    }),
    devices: async () => ({
      items: [
        {
          id: id(50),
          name: 'Pool gate',
          surface: 'operator',
          online: false,
          lastSeenAt: NOW - 240_000,
          self: false,
        },
      ],
    }),
    summary: async () => ({ ok: 7, refused: 1, headsUp: 0, undone: 0 }),
    rollCall: async () => ({ rollCall: current }),
    rollCallMarks: async (
      _id: string,
      body: { marks: { passId: string; status: 'present' | 'out' | 'none' }[] },
    ) => {
      marks(body.marks);
      if (!current) throw new Error('no call');
      const next = structuredClone(current);
      for (const m of body.marks) {
        const p = next.people.find((x) => x.passId === m.passId);
        if (p)
          p.mark = m.status === 'none' ? null : { status: m.status, by: 'Front desk', at: NOW };
      }
      next.rev += 1;
      next.counts.present = next.people.filter((p) => p.mark?.status === 'present').length;
      next.counts.unconfirmed = next.people.filter((p) => !p.mark).length;
      current = next;
      return {
        ...next,
        results: body.marks.map((m) => ({
          rollCallId: next.id,
          passId: m.passId,
          status: 'applied' as const,
        })),
      };
    },
  } as unknown as ScanApi;
  const store = createScanStore(fakeDeps().deps, states.ready());
  const fields = new WedgeFields();
  const runtime = { emit: vi.fn(), checkIn: () => undefined, fields } as unknown as ScanRuntime;
  const base = sessionFixture();
  const session = {
    ...base,
    staff: role === 'desk' ? { id: id(1), name: 'Theo B.', role: 'desk' } : null,
    counts: { ...fixtureCounts(), place: { name: 'Gym floor', inNow: 3, capacity: 10 } },
    scanner: base.scanner && {
      ...base.scanner,
      settings: { ...base.scanner.settings, roleWithoutSignIn: role },
    },
  } as unknown as ScanSession;
  render(
    <ThemeProvider>
      <ScanStoreContext.Provider value={store}>
        <WedgeFieldsContext.Provider value={fields}>
          <OperatorWorkspace
            live={false}
            api={api}
            runtime={runtime}
            session={session}
            counts={session.counts}
            branding={null}
            logoUrl={null}
            modeLabel="Operator"
            chips={null}
            testing={null}
            menu={null}
            scanCard={null}
            announcement={null}
            onTitle={() => undefined}
          />
        </WedgeFieldsContext.Provider>
      </ScanStoreContext.Provider>
    </ThemeProvider>,
  );
  return { marks, runtime };
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: (q: string) => ({
      matches: q.includes('1280'),
      addEventListener() {},
      removeEventListener() {},
    }),
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('the floor and its views', () => {
  it('gives a Desk scanner that counts a place Who’s in, and a Door neither', async () => {
    setup({ roll: false });
    const tabs = within(screen.getByRole('tablist'));
    expect(
      tabs.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+|need you/g, '').trim()),
    ).toEqual(['Activity', 'Problems', 'Who’s in'.replace('’', "'")]);
  });

  it('shows a Door only Activity and Problems, and no floor cards beyond its count and shift', async () => {
    setup({ role: 'door', roll: false });
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2);
    const floor = await screen.findByRole('complementary', { name: 'Floor' });
    expect(within(floor).queryByRole('region', { name: 'Devices' })).toBeNull();
    expect(await within(floor).findByRole('region', { name: 'Your shift' })).toBeTruthy();
  });

  it('lists the session’s devices with how long one has been gone', async () => {
    setup({ roll: false });
    const devices = await screen.findByRole('region', { name: 'Devices' });
    expect(await within(devices).findByText('Pool gate')).toBeTruthy();
    expect(within(devices).getByText('Offline · 4 min')).toBeTruthy();
  });
});

describe('the roll call takes the list', () => {
  it('replaces the tabs with the call, shows its chip, and swaps the floor for its own cards', async () => {
    setup();
    expect(await screen.findByRole('region', { name: 'Roll call' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('Roll call', { selector: '.op-chip-roll' })).toBeTruthy();
    const floor = screen.getByRole('complementary', { name: 'Floor' });
    expect(within(floor).getByRole('region', { name: 'By zone' })).toBeTruthy();
    expect(within(floor).getByRole('button', { name: 'End roll call' })).toBeTruthy();
    expect(screen.getByText('0 of 3')).toBeTruthy();
  });

  it('marks Safe from the person’s strip and goes on to the next one still to confirm', async () => {
    const { marks } = setup();
    const rows = await screen.findAllByTestId('roll-call-row');
    // Longest inside first: Ada, then Bo.
    fireEvent.click(within(rows[0] as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    const strip = await screen.findByRole('group', { name: 'Roll call' });
    expect(within(strip).getByText('Not confirmed')).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: /^Safe/ }));
    await waitFor(() =>
      expect(marks).toHaveBeenCalledWith([
        expect.objectContaining({ passId: id(3), status: 'present' }),
      ]),
    );
    await waitFor(() => expect(screen.getByText('1 of 3')).toBeTruthy());
    // The next person to confirm is open now.
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Roll call' })).getByText('Not confirmed'),
      ).toBeTruthy(),
    );
  });

  it('takes S and X as the call’s own keys on the open person', async () => {
    const { marks } = setup();
    const rows = await screen.findAllByTestId('roll-call-row');
    fireEvent.click(within(rows[0] as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    await screen.findByRole('group', { name: 'Roll call' });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
    });
    await waitFor(
      () =>
        expect(marks).toHaveBeenCalledWith([
          expect.objectContaining({ passId: id(3), status: 'out' }),
        ]),
      { timeout: 2000 },
    );
  });
});
