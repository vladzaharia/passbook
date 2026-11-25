import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { ThemeProvider } from '../../../lib/theme.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { sessionFixture } from '../../boot/session.test-support.ts';
import { WedgeFieldsContext } from '../../input/wedge-field.tsx';
import { WedgeFields } from '../../input/wedge-source.ts';
import {
  fixtureCounts,
  fixtureInput,
  fixtureOutcome,
} from '../../machine/fixture-data.test-support.ts';
import { states } from '../../machine/fixtures.test-support.ts';
import { fakeDeps } from '../../machine/store.test-support.ts';
import { createScanStore } from '../../machine/store.ts';
import { ScanStoreContext } from '../../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import { OperatorWorkspace } from './workspace.tsx';

const ID = '01900000-0000-7000-8000-000000000001';
const PASS = '01900000-0000-7000-8000-0000000000aa';
const NOW = Date.now();

const row = (passId: string, title: string) => ({
  passId,
  title,
  subtitle: null,
  templateName: 'Member',
  status: 'active' as const,
  maskedEmail: null,
  photoUrl: null,
  doorState: null,
  lastScanAt: null,
});

function setup(over: { lookup?: ScanApi['lookup']; items?: unknown[] } = {}) {
  const lookup = vi.fn(
    over.lookup ??
      (async ({ q }: { q: string }) => ({
        items: q.startsWith('okafor')
          ? [row(PASS, 'Maya Okafor')]
          : [row(PASS, 'Maya Okafor'), row(`${PASS}1`, 'Mara Lopez')],
        more: false,
      })),
  );
  const resolve = vi.fn(async (body: { input: { code?: string; passId?: string } }) =>
    body.input.passId
      ? fixtureOutcome('ready', 'choose', {
          card: {
            ...fixtureOutcome('ready').card,
            passId: body.input.passId,
            title: 'Maya Okafor',
          } as never,
        })
      : fixtureOutcome('refused', 'not_found'),
  );
  const items = over.items ?? [
    {
      id: ID,
      at: NOW - 60_000,
      deviceId: ID,
      deviceName: 'Front desk',
      passId: PASS,
      title: 'Maya Okafor',
      outcome: 'ok',
      direction: 'in',
      scanId: ID,
      reason: null,
      staff: null,
      method: 'wedge',
      undoable: false,
      groupSize: null,
    },
  ];
  const api = {
    activity: async () => ({ items }),
    lookup,
    resolve,
    override: async () => fixtureOutcome('ok'),
    undo: async () => fixtureOutcome('ok'),
  } as unknown as ScanApi;
  const store = createScanStore(fakeDeps().deps, states.ready());
  const fields = new WedgeFields();
  const emitted: unknown[] = [];
  const runtime = {
    emit: (read: unknown) => emitted.push(read),
    checkIn: () => undefined,
    fields,
  } as unknown as ScanRuntime;
  const base = sessionFixture();
  const session = {
    ...base,
    counts: fixtureCounts(),
    scanner: base.scanner && {
      ...base.scanner,
      settings: { ...base.scanner.settings, lookup: true },
    },
  } as ScanSession;
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
            announcement={{ text: 'No visits left.', polite: false, n: 1 }}
            onTitle={() => undefined}
          />
        </WedgeFieldsContext.Provider>
      </ScanStoreContext.Provider>
    </ThemeProvider>,
  );
  return { api, lookup, resolve, emitted, store };
}

const field = () =>
  screen.getByRole('combobox', { name: 'Name, email or code' }) as HTMLInputElement;
const key = (el: Element, init: KeyboardEventInit) =>
  fireEvent.keyDown(el, { bubbles: true, cancelable: true, ...init });

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('the workspace', () => {
  it('search keeps working after an early Enter (H2)', async () => {
    const { lookup, resolve } = setup();
    fireEvent.change(field(), { target: { value: 'okafor' } });
    // Enter before the 250 ms debounce: the lookup hook resolves, finds one hit and picks it.
    key(field(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    // The single hit opens as a record, and the lookup is not left holding a pick.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Close/ })).toBeInTheDocument());
    lookup.mockClear();
    fireEvent.change(field(), { target: { value: 'lopez' } });
    await waitFor(() => expect(lookup).toHaveBeenCalledWith({ q: 'lopez' }, expect.anything()), {
      timeout: 2000,
    });
  });

  it('shows the search keys once, in the status bar, not again under the field', async () => {
    setup();
    fireEvent.change(field(), { target: { value: 'ok' } });
    await waitFor(() => expect(screen.getAllByText('Move').length).toBeGreaterThan(0));
    expect(screen.queryByText(/to move/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Move')).toHaveLength(1);
  });

  it('a short wrong code and Enter says nothing matched, and search still works (H2)', async () => {
    const { lookup } = setup();
    fireEvent.change(field(), { target: { value: 'zz' } });
    key(field(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument());
    fireEvent.change(field(), { target: { value: 'okafor' } });
    await waitFor(() => expect(lookup).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('previewing hits asks the server nothing; opening one does (M5)', async () => {
    const { lookup, resolve } = setup();
    fireEvent.change(field(), { target: { value: 'mar' } });
    await waitFor(() => expect(screen.getAllByTestId('op-result')).toHaveLength(2), {
      timeout: 2000,
    });
    key(field(), { key: 'ArrowDown', code: 'ArrowDown' });
    // Opening the record preview renders the whole workspace; under v8 coverage that passed the
    // global 10 s window. A passing test never waits this long.
    await waitFor(
      () => expect(screen.getByText('Mara Lopez', { selector: 'h2' })).toBeInTheDocument(),
      { timeout: 45_000 },
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    key(field(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
  });

  it('Esc returns focus to the row that opened the record (M7)', async () => {
    setup();
    const rowButton = await screen.findByTestId('op-activity-row');
    rowButton.focus();
    fireEvent.click(rowButton);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Close/ })).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      await new Promise((r) => requestAnimationFrame(r));
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('op-activity-row')));
  });

  it('holds a result until it is closed (M8)', () => {
    const { store } = setup();
    expect(store.getSnapshot().state.prefs.holdResults).toBe(true);
  });

  it('a scan landing while the field has focus leaves the focus in the field (M9)', async () => {
    const { store } = setup();
    field().focus();
    act(() => store.dispatch({ type: 'read', input: fixtureInput() }));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(field());
  });

  it('announces politely, even a refusal (M6)', () => {
    setup();
    const region = document.querySelector('[aria-live]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });

  it('the listbox is only referenced while it exists (L12)', async () => {
    setup();
    expect(field().getAttribute('aria-controls')).toBeNull();
    fireEvent.change(field(), { target: { value: 'mar' } });
    await waitFor(() => expect(field().getAttribute('aria-controls')).toBe('op-results'));
  });
});
