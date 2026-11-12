import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import type { DesignDoc } from '../model.ts';
import { ScanStage } from './scan-stage.tsx';
import { fixture, Stage } from './scan-stage-test-fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

describe('scan preview stage', () => {
  it('links row selections, locks system content and supports every outcome for a non-event check-in', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const { rerender } = render(<Stage onSelect={select} />);
    const canvas = screen.getByRole('group', { name: 'Scan screen preview, Check in' });
    expect(within(canvas).getByText('A12')).toBeVisible();
    expect(screen.getByText(/Phone fit:/)).toBeInTheDocument();
    await user.click(within(canvas).getByRole('button', { name: 'Row field' }));
    expect(select).toHaveBeenCalledWith('r_seat');
    rerender(<Stage selected="r_seat" onSelect={select} />);
    expect(within(canvas).getByRole('button', { name: 'Row field' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    select.mockClear();
    await user.click(within(canvas).getByRole('button', { name: /System\. The verdict/ }));
    expect(select).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}');
    expect(within(canvas).getByRole('button', { name: /System\. The holder line/ })).toHaveFocus();
    await user.click(screen.getByRole('tab', { name: 'Card' }));
    expect(screen.getByRole('group', { name: 'Scan screen preview, Card' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Heads-up' }));
    expect(screen.getByText('Already checked in')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Refused' }));
    const refused = screen.getByRole('group', { name: 'Scan screen preview, Refused' });
    expect(within(refused).getByText('See the desk.')).toBeVisible();
    expect(within(refused).queryByText('A12')).not.toBeInTheDocument();
  });

  it('dispatches edit shortcuts only for editable canvas elements', () => {
    const action = vi.fn();
    const { rerender } = render(<Stage onAction={action} />);
    const canvas = screen.getByRole('group', { name: 'Scan screen preview, Check in' });
    const row = within(canvas).getByRole('button', { name: 'Row field' });
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(row, { key: 'd', metaKey: true });
    fireEvent.keyDown(row, { key: 'd', ctrlKey: true });
    fireEvent.keyDown(row, { key: 'Delete' });
    expect(action.mock.calls).toEqual([
      ['r_seat', 'up'],
      ['r_seat', 'down'],
      ['r_seat', 'duplicate'],
      ['r_seat', 'duplicate'],
      ['r_seat', 'remove'],
    ]);
    action.mockClear();
    const locked = within(canvas).getByRole('button', { name: /System\. The verdict/ });
    fireEvent.keyDown(locked, { key: 'Delete' });
    fireEvent.keyDown(locked, { key: 'ArrowUp', altKey: true });
    expect(action).not.toHaveBeenCalled();
    rerender(<Stage phone onAction={action} />);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Scan screen preview, Check in' }), {
      key: 'Delete',
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('uses event-specific outcome labels while retaining the ready preview', async () => {
    const user = userEvent.setup();
    const { doc, display } = fixture();
    doc.passJson = { eventTicket: { primaryFields: [{ key: 'seat', label: 'Seat' }] } };
    function EventStage() {
      const [current, setCurrent] = useState<ScanDisplayScreen>('ok');
      return (
        <ScanStage
          doc={doc}
          display={display}
          templateId="tpl1"
          orgId="org1"
          mode="test"
          screen={current}
          onScreenChange={setCurrent}
          selected={null}
          onSelect={() => {}}
          phone={false}
        />
      );
    }
    render(<EventStage />);
    expect(screen.getByRole('tab', { name: 'Checked in' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Already checked in' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Card' }));
    expect(screen.getByRole('group', { name: 'Scan screen preview, Card' })).toBeVisible();
  });

  it('previews each action with its own action-filtered panels and selectable hidden rules', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const { doc, display } = fixture();
    doc.manifest.scan = {
      actions: [
        { id: 'add', label: 'Add stamp', kind: 'add', input: 'seat' },
        { id: 'redeem', label: 'Redeem', kind: 'take', input: 'seat' },
      ],
    };
    display.panels = [
      {
        id: 'p_reward',
        title: 'Reward',
        actions: ['redeem'],
        rows: [{ id: 'r_reward', type: 'field', label: 'Seat', value: '{{inputs.seat}}' }],
      },
      {
        id: 'p_hidden',
        title: 'Lounge',
        when: { path: 'inputs.seat', eq: 'Z99' },
        rows: [{ id: 'r_hidden', type: 'field', label: 'Seat', value: '{{inputs.seat}}' }],
      },
    ];
    function Actions() {
      const [current, setCurrent] = useState<ScanDisplayScreen>('ok');
      return (
        <ScanStage
          doc={doc}
          display={display}
          templateId="tpl1"
          orgId="org1"
          mode="test"
          screen={current}
          onScreenChange={setCurrent}
          selected={null}
          onSelect={select}
          phone={false}
        />
      );
    }
    render(<Actions />);
    expect(screen.queryByText('A12')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lounge, hidden for this sample' }));
    expect(select).toHaveBeenCalledWith('p_hidden');
    await user.click(screen.getByRole('tab', { name: 'Redeem' }));
    const canvas = screen.getByRole('group', { name: 'Scan screen preview, Redeem' });
    expect(within(canvas).getByText('A12')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Add stamp' }));
    expect(screen.queryByText('A12')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Card' }));
    expect(screen.getByText('Add stamp · Desk required')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Desk' }));
    expect(screen.queryByText('Add stamp · Desk required')).not.toBeInTheDocument();
  });

  it('keeps phone canvas and fit report free of edit targets', () => {
    const select = vi.fn();
    render(<Stage phone onSelect={select} />);
    const canvas = screen.getByRole('group', { name: 'Scan screen preview, Check in' });
    expect(within(canvas).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('Edit synthetic sample inputs')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Door' })).toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not replace a malformed authored display with the default preview', () => {
    const { doc } = fixture();
    const actions = [{ id: 'check_in', label: 'Check in', kind: 'check_in' }];
    const malformed: DesignDoc = {
      ...doc,
      manifest: { ...doc.manifest, scan: { actions, display: { v: 9, header: {}, panels: [] } } },
    };
    const absent: DesignDoc = { ...doc, manifest: { ...doc.manifest, scan: { actions } } };
    const props = {
      display: null,
      templateId: 'tpl1',
      orgId: 'org1',
      mode: 'test' as const,
      screen: 'ok' as const,
      onScreenChange: vi.fn(),
      selected: null,
      onSelect: vi.fn(),
      phone: false,
    };
    const { rerender } = render(<ScanStage {...props} doc={malformed} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The authored scan screen is invalid');
    rerender(<ScanStage {...props} doc={absent} />);
    expect(screen.queryByText(/The authored scan screen is invalid/)).not.toBeInTheDocument();
    expect(screen.getByText('A12')).toBeVisible();
  });
});
