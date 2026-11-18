import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { ScanReasonSchema } from '../../../shared/contracts/scan.ts';
import { FIXTURE_NOW, fixtureOutcome, fixtureState } from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import type { Recent } from '../machine/types.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import { RecentScans, rowLabel } from './recent-scans.tsx';
import { stripOf } from './strip-of.ts';

const row = (outcome: ReturnType<typeof fixtureOutcome>): Recent => ({
  scanId: outcome.scanId,
  at: FIXTURE_NOW,
  outcome,
  undoable: false,
});

describe('Recent rows show copy, never a reason code', () => {
  it.each(ScanReasonSchema.options)('%s reads as its headline', (reason) => {
    const label = rowLabel(fixtureOutcome('heads_up', reason), FIXTURE_NOW);
    expect(label).not.toBe(reason);
    expect(label).not.toMatch(/[{}_]/);
  });

  it('shows the action for an ok row and Undone for an undo', () => {
    expect(rowLabel(fixtureOutcome('ok'), FIXTURE_NOW)).toBe('Add stamp');
    expect(
      rowLabel(
        fixtureOutcome('ok', null, { action: { id: 'undo', label: 'Add stamp', kind: 'add' } }),
        FIXTURE_NOW,
      ),
    ).toBe('Undone');
  });

  it('renders the list with headlines and passes axe', async () => {
    const recent = [
      row(fixtureOutcome('heads_up', 'cooldown', { action: null })),
      row(fixtureOutcome('refused', 'not_found', { action: null })),
    ];
    const store = createScanStore(fakeDeps().deps, fixtureState({ recent }));
    const wrap = ({ children }: { children: ReactNode }) => (
      <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
    );
    render(<RecentScans open onClose={() => undefined} />, { wrapper: wrap });
    expect(screen.getByText(/Just done/)).toBeVisible();
    expect(screen.getByText(/Not found/)).toBeVisible();
    expect(screen.queryByText(/not_found|cooldown/)).toBeNull();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});

describe('the dock strip says what a refusal was', () => {
  it('puts the headline in the meta when the holder is known, and the title when not', () => {
    const known = stripOf(row(fixtureOutcome('refused', 'voided')), false);
    expect(known?.meta).toMatch(/^Voided · /);
    const unknown = stripOf(
      row(fixtureOutcome('refused', 'not_found', { display: null, card: null, action: null })),
      false,
    );
    expect(unknown?.title).toBe('Not found');
  });
});
