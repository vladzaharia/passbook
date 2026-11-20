import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
});
