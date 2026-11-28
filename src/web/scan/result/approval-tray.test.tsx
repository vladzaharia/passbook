import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectSecretAbsent } from '../../../../test/helpers/secret-absent.ts';
import '../../lib/test-utils.tsx';
import type { RawRead } from '../input/types.ts';
import { createWedgeSource, WedgeFields } from '../input/wedge-source.ts';
import { fakeClock } from '../machine/store.test-support.ts';
import { shortName } from './approval-parts.tsx';
import { ApprovalTray, type ApprovalTrayProps } from './approval-tray.tsx';

const maya = { id: 'm1', name: 'Maya Ruiz', role: 'manager' };
const noor = { id: 'm2', name: 'Noor Khan', role: 'manager' };

function setup(over: Partial<ApprovalTrayProps> = {}) {
  const props: ApprovalTrayProps = {
    action: 'Redeem 1 Free coffee',
    managers: [maya],
    code: false,
    desk: false,
    busy: false,
    onApprove: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  const view = render(<ApprovalTray {...props} />);
  return {
    ...props,
    view,
    rerender: (next: Partial<ApprovalTrayProps>) =>
      view.rerender(<ApprovalTray {...props} {...next} />),
  };
}
const key = (d: string) => fireEvent.click(screen.getByRole('button', { name: d }));
const keys = (digits: string) => {
  for (const d of digits) key(d);
};

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('Manager PIN tray', () => {
  it('names the action and the manager', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Manager PIN' })).toBeVisible();
    expect(screen.getByText('Approves: Redeem 1 Free coffee')).toBeVisible();
    expect(screen.getByText('Maya Ruiz')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('announces how many digits, never which', () => {
    setup();
    keys('482');
    expect(screen.getByRole('status')).toHaveTextContent('3 of 6 digits');
    expect(screen.getByRole('img', { name: 'PIN, 3 of 6 digits' })).toBeVisible();
    const live = document.body.textContent ?? '';
    expect(screen.getByRole('status').textContent).not.toMatch(/482/);
    expect(live).not.toContain('482 ');
  });

  it('sends the six digits once, as one string, and keeps none', () => {
    const { onApprove } = setup();
    keys('482913');
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('m1', '482913');
    expect(screen.getByRole('status')).toHaveTextContent('Checking PIN');
    for (const k of screen.getAllByRole('button', { name: /^(\d|Delete)$/ }))
      expect(k).toHaveAttribute('aria-disabled', 'true');
    expect(document.querySelector('input')).toBeNull();
    expectSecretAbsent(document.body.innerHTML, '482913');
  });

  it('a reader typing a code into the tray is a scan: it never fills or sends the PIN', () => {
    const clock = fakeClock();
    const emitted: RawRead[] = [];
    const stop = createWedgeSource({ clock, fields: new WedgeFields() }).start((r) =>
      emitted.push(r),
    );
    const { onApprove } = setup();
    const target = screen.getByRole('button', { name: '1' });
    target.focus();
    const press = (key: string, code: string) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }),
      );
    for (const d of '48291305') {
      press(d, `Digit${d}`);
      clock.advance(10);
    }
    press('Enter', 'Enter');
    stop();
    expect(emitted).toEqual([{ method: 'wedge', code: '48291305' }]);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByRole('img', { name: 'PIN, 0 of 6 digits' })).toBeVisible();
  });

  it('a typed digit on a physical keyboard is not taken either', () => {
    const { onApprove } = setup();
    const group = screen.getByRole('group', { name: 'Manager PIN' });
    for (const d of '1234567') fireEvent.keyDown(group, { key: d });
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('delete takes the last digit back', () => {
    const { onApprove } = setup();
    keys('1234');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('status')).toHaveTextContent('3 of 6 digits');
    keys('789');
    expect(onApprove).toHaveBeenCalledWith('m1', '123789');
  });

  it('clears the digits when the app goes to the background', () => {
    const { onApprove } = setup();
    keys('1234');
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    hidden.mockRestore();
    expect(screen.getByRole('status')).toHaveTextContent('PIN cleared.');
    keys('12345');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('clears the digits after a pause', () => {
    const { onApprove } = setup();
    keys('1234');
    act(() => {
      vi.advanceTimersByTime(30_001);
    });
    expect(screen.getByRole('status')).toHaveTextContent('PIN cleared.');
    keys('12345');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('shows a refused PIN with the tries left and takes a fresh one', () => {
    const { onApprove, rerender } = setup();
    keys('111111');
    rerender({ note: { triesLeft: 2 } });
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong PIN. 2 tries left.');
    keys('222222');
    expect(onApprove).toHaveBeenLastCalledWith('m1', '222222');
    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it('shows the lockout and stops taking digits', () => {
    const { onApprove, rerender } = setup();
    rerender({ note: { locked: true, retryAfterMs: 240_000 } });
    expect(screen.getByRole('alert')).toHaveTextContent('Too many tries. Try again in 4 min.');
    for (const k of screen.getAllByRole('button', { name: /^\d$/ }))
      expect(k).toHaveAttribute('aria-disabled', 'true');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('says so when the PIN got no answer, and takes a fresh one', () => {
    const { onApprove, rerender } = setup();
    keys('111111');
    rerender({ note: { unreachable: true } });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't check the PIN. Try again.");
    keys('222222');
    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it('a lockout ends on its own: the keys come back when the wait is over', () => {
    const { onApprove, rerender } = setup();
    rerender({ note: { locked: true, retryAfterMs: 60_000 } });
    keys('111111');
    expect(onApprove).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('');
    keys('222222');
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('m1', '222222');
  });

  it('a PIN nobody answered frees the keys again', () => {
    const { onApprove } = setup();
    keys('111111');
    expect(screen.getByRole('status')).toHaveTextContent('Checking PIN');
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    keys('222222');
    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it('names whose pass it is, since the card behind is only a band', () => {
    setup({ who: 'Anna Popescu · Coffee card' });
    expect(screen.getByText('Anna Popescu · Coffee card')).toBeVisible();
  });

  it('changing the manager drops the digits already keyed', () => {
    const { onApprove } = setup({
      managers: [
        { ...maya, id: 'x1' },
        { ...noor, id: 'x2' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Maya Ruiz/ }));
    keys('123');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: /Noor Khan/ }));
    expect(screen.getByRole('img', { name: 'PIN, 0 of 6 digits' })).toBeVisible();
    keys('456');
    expect(onApprove).not.toHaveBeenCalled();
    keys('789');
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('x2', '456789');
  });

  it('asks who approves when several may, then remembers who for the next time', () => {
    const { onApprove, view } = setup({ managers: [maya, noor] });
    expect(screen.getByRole('button', { name: /Maya Ruiz/ })).toBeVisible();
    expect(screen.queryByRole('img', { name: /PIN/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Noor Khan/ }));
    expect(screen.getByRole('button', { name: 'Change' })).toBeVisible();
    keys('123456');
    expect(onApprove).toHaveBeenCalledWith('m2', '123456');
    view.unmount();
    setup({ managers: [maya, noor] });
    expect(screen.getByText('Noor Khan')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Maya Ruiz/ })).toBeNull();
  });

  it('with staff sign-in off the six digits alone find the manager', () => {
    const { onApprove } = setup({ managers: [], code: true });
    expect(screen.getByRole('dialog', { name: 'Manager code' })).toBeVisible();
    expect(screen.queryByText('Manager', { exact: true })).toBeNull();
    keys('123456');
    expect(onApprove).toHaveBeenCalledWith(undefined, '123456');
  });

  it('writes the PIN nowhere: no storage, no URL', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const url = location.href;
    setup();
    keys('482913');
    expect(set).not.toHaveBeenCalled();
    expect(location.href).toBe(url);
    set.mockRestore();
  });

  it('Cancel leaves; it waits while the PIN is with the server', () => {
    const { onCancel, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender({ busy: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('shortName', () => {
  it('is first name and last initial', () => {
    expect(shortName('Maya Ruiz')).toBe('Maya R.');
    expect(shortName('Ana María de la Cruz')).toBe('Ana C.');
    expect(shortName('Maya')).toBe('Maya');
  });
});
