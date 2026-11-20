import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureOutcome, states } from '../machine/fixtures.test-support.ts';
import { fakeDeps } from '../machine/store.test-support.ts';
import { createScanStore } from '../machine/store.ts';
import { ScanStoreContext } from '../machine/use-scan-machine.ts';
import { ApprovalDock, type DockApproval } from './approval-dock.tsx';

const needs = (approvals: boolean) =>
  fixtureOutcome('heads_up', 'needs_approval', {
    approvals,
    action: { id: 'redeem', label: 'Redeem 1 Free coffee', kind: 'add' },
  });
const approval = (over: Partial<DockApproval> = {}): DockApproval => ({
  managers: [{ id: 'm1', name: 'Maya Ruiz', role: 'manager' }],
  code: false,
  approvals: 'managers',
  onApprove: vi.fn(),
  ...over,
});

function dock(outcome: ReturnType<typeof needs>, props: DockApproval, busy = false) {
  const store = createScanStore(fakeDeps().deps, states.ready());
  const dispatch = vi.spyOn(store, 'dispatch');
  const wrap = ({ children }: { children: ReactNode }) => (
    <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
  );
  const view = render(<ApprovalDock outcome={outcome} approval={props} busy={busy} />, {
    wrapper: wrap,
  });
  return { dispatch, view };
}

describe('the dock under needs_approval on a handheld', () => {
  it('makes Manager PIN the primary, with Done beside it', () => {
    const { dispatch } = dock(needs(true), approval());
    const primary = screen.getByRole('button', { name: 'Manager PIN' });
    expect(primary).toHaveAttribute('data-testid', 'dock-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'dismiss' });
  });

  it('opens the tray, and Cancel closes it', () => {
    dock(needs(true), approval());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    expect(screen.getByRole('dialog', { name: 'Manager PIN' })).toBeVisible();
    expect(screen.getByText('Approves: Redeem 1 Free coffee')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('six digits go to onApprove with the manager', () => {
    const onApprove = vi.fn();
    dock(needs(true), approval({ onApprove }));
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    for (const d of '123456') fireEvent.click(screen.getByRole('button', { name: d }));
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('m1', '123456');
  });

  it('a refused PIN opens the tray again with the tries left', () => {
    const { view } = dock(needs(true), approval());
    view.rerender(
      <ApprovalDock
        outcome={needs(true)}
        approval={approval({ note: { triesLeft: 1 } })}
        busy={false}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong PIN. 1 tries left.');
  });

  it('another scan replacing the hold closes the tray and drops what was keyed', () => {
    const { view } = dock(needs(true), approval());
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    for (const d of '123') fireEvent.click(screen.getByRole('button', { name: d }));
    view.rerender(<ApprovalDock outcome={needs(true)} approval={approval()} busy={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    expect(screen.getByRole('img', { name: 'PIN, 0 of 6 digits' })).toBeVisible();
  });

  it('the camera waits while the tray is up, and wakes when it goes', () => {
    const { dispatch } = dock(needs(true), approval());
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'overlay', open: 'settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'overlay', open: null });
  });

  it('names whose pass is being approved', () => {
    dock(needs(true), approval());
    fireEvent.click(screen.getByRole('button', { name: 'Manager PIN' }));
    expect(screen.getByText(/Coffee card/)).toBeVisible();
  });

  it('says to ask an admin when nobody may approve', () => {
    dock(needs(false), approval());
    expect(screen.getByText('Ask an admin to allow it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Manager PIN' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute(
      'data-testid',
      'dock-primary',
    );
  });

  it('with staff sign-in off the button says manager code', () => {
    dock(needs(true), approval({ code: true, managers: [] }));
    expect(screen.getByRole('button', { name: 'Use manager code' })).toBeVisible();
  });
});
