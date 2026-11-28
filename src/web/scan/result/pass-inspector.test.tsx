import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createQueryClient } from '../../lib/query-client.ts';
import '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import {
  FIXTURE_NOW,
  fixtureCard,
  fixtureDisplay,
  fixtureOutcome,
  fixtureState,
} from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import { PassInspector } from './pass-inspector.tsx';

const outcome = fixtureOutcome('ok', null, { card: fixtureCard(), display: fixtureDisplay('ok') });
const wrap = (store: ReturnType<typeof createScanStore>) =>
  function Wrap({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={createQueryClient()}>
        <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
      </QueryClientProvider>
    );
  };

describe('the pass sheet', () => {
  const recent = [{ scanId: outcome.scanId, at: FIXTURE_NOW, outcome, undoable: true }];
  const store = () => createScanStore(fakeDeps().deps, fixtureState({ recent }));
  it('opens on This pass with the verdict, the display and Undo, and passes axe', async () => {
    render(
      <PassInspector
        inspection={{ outcome, card: outcome.card }}
        api={{} as ScanApi}
        where="Front door"
        onClose={vi.fn()}
      />,
      { wrapper: wrap(store()) },
    );
    expect(screen.getByTestId('scan-pass-verdict')).toHaveTextContent(/Front door/);
    expect(screen.getByText('Coffee card')).toBeVisible();
    expect(screen.getByRole('button', { name: /Undo check-in|Undo/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Show pass/ })).toBeVisible();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
  it('switches to Recent scans', async () => {
    render(
      <PassInspector
        inspection={{ outcome, card: outcome.card }}
        api={{} as ScanApi}
        onClose={vi.fn()}
      />,
      {
        wrapper: wrap(store()),
      },
    );
    screen.getByRole('radio', { name: 'Recent scans' }).click();
    expect(await screen.findByTestId('scan-recent')).toBeVisible();
  });

  it('keeps every action reachable: the third and later go in More', () => {
    const held = fixtureOutcome('heads_up', 'already_done', {
      card: fixtureCard({
        lastScans: [
          {
            scanId: '01900000-0000-7000-8000-000000000041',
            at: FIXTURE_NOW - 3_600_000,
            actionLabel: 'Checked in',
            outcome: 'ok',
            scannerName: 'Side door',
            undoable: false,
          },
        ],
        tag: { hint: '4F2A', assurance: 'basic', scope: 'pass', typeName: 'Wristband' },
      }),
      display: fixtureDisplay('heads_up'),
      action: { id: 'add_stamp', label: 'Add stamp', kind: 'add' },
      undoUntil: FIXTURE_NOW + 1e12,
    });
    const rows = [{ scanId: held.scanId, at: FIXTURE_NOW, outcome: held, undoable: true }];
    const st = createScanStore(fakeDeps().deps, fixtureState({ recent: rows }));
    render(
      <PassInspector
        inspection={{ outcome: held, card: held.card, live: true }}
        api={{} as ScanApi}
        where="Front door"
        onClose={vi.fn()}
      />,
      { wrapper: wrap(st) },
    );
    expect(screen.getByRole('button', { name: 'Let in' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Undo/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Show pass/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: /Show pass/ })).toBeVisible();
  });
  it("lists this pass's scans today, says you for this device, and the bound tag", () => {
    const card = fixtureCard({
      lastScans: [
        {
          scanId: '01900000-0000-7000-8000-000000000041',
          at: FIXTURE_NOW - 3_600_000,
          actionLabel: 'Checked in',
          outcome: 'ok',
          scannerName: 'Side door',
          undoable: false,
        },
      ],
      tag: { hint: '4F2A', assurance: 'basic', scope: 'pass', typeName: 'Wristband' },
    });
    render(
      <PassInspector
        inspection={{ outcome: { ...outcome, card }, card }}
        api={{} as ScanApi}
        where="Front door"
        onClose={vi.fn()}
      />,
      { wrapper: wrap(createScanStore(fakeDeps().deps, fixtureState({ recent: [] }))) },
    );
    const today = screen.getByRole('region', { name: 'Today' });
    expect(today).toHaveTextContent('Side door');
    expect(today).toHaveTextContent('Front door');
    expect(today).toHaveTextContent('Tag linked');
    expect(today).toHaveTextContent('Ends 4F2A');
  });
});
