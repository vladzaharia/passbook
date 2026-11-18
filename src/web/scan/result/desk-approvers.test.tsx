import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { fixtureCard, fixtureDisplay, fixtureOutcome } from '../machine/fixtures.test-support.ts';
import { deskOf } from './desk.ts';
import { ResultCard } from './result-card.tsx';

const LIST = [
  { id: 'm1', name: 'Mara', role: 'manager' as const },
  { id: 'd1', name: 'Dan', role: 'desk' as const },
  { id: 'd2', name: 'Dee', role: 'desk' as const },
  { id: 'g1', name: 'Gus', role: 'door' as const },
];
const loop = { s: 'ready' } as never;
const as = (approvals: 'managers' | 'desk' | undefined, self: string | null) =>
  ({
    staffList: LIST,
    staff: self ? { id: self } : null,
    scanner: { settings: { approvals } },
  }) as unknown as Parameters<typeof deskOf>[1] & { staffList: typeof LIST };
const names = (d: ReturnType<typeof deskOf>) => d.managers.map((m) => m.name);

describe('who may approve in the scanner', () => {
  it('lists managers only under Managers, and never the signed-in person', () => {
    expect(names(deskOf(loop, as('managers', 'd1'), vi.fn()))).toEqual(['Mara']);
    expect(names(deskOf(loop, as(undefined, null), vi.fn()))).toEqual(['Mara']);
  });
  it('adds Desk staff under Desk staff too, minus the person asking', () => {
    expect(names(deskOf(loop, as('desk', 'd1'), vi.fn()))).toEqual(['Mara', 'Dee']);
  });

  const needs = () =>
    fixtureOutcome('heads_up', 'needs_approval', {
      card: fixtureCard(),
      display: fixtureDisplay('ok'),
      approvals: true,
      action: { id: 'stamp', label: 'Add stamp', kind: 'add' },
    });

  it('one manager who is out, a desk lead picks themselves and the request names them', () => {
    const d = deskOf(loop, { ...as('desk', 'g1'), staffList: LIST.slice(0, 2) }, vi.fn());
    const onApprove = vi.fn();
    render(<ResultCard outcome={needs()} desk={{ ...d, onApprove }} />);
    expect(screen.getByTestId('scan-verdict')).toHaveTextContent('Needs a manager or desk lead');
    fireEvent.click(screen.getByTestId('scan-manager-pin'));
    // Two may approve: nobody is chosen for the person.
    expect(screen.getByLabelText('Approver')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '123456' } });
    // A PIN with no one chosen is never sent.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.submit(screen.getByTestId('scan-approval'));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('keeps the Manager words under Managers', () => {
    const d = deskOf(loop, as('managers', 'g1'), vi.fn());
    render(<ResultCard outcome={needs()} desk={d} />);
    expect(screen.getByTestId('scan-verdict')).toHaveTextContent('Needs a manager');
    expect(screen.getByTestId('scan-verdict')).not.toHaveTextContent('desk lead');
  });
});
