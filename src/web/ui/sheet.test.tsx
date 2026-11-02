import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet, SheetContent } from './sheet.tsx';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 300 });
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
});

function open(onOpenChange = vi.fn()) {
  render(
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent title="Menu" side="right">
        <p>Body</p>
      </SheetContent>
    </Sheet>,
  );
  return { onOpenChange, sheet: screen.getByRole('dialog') };
}

const drag = (sheet: HTMLElement, dx: number, ms: number, pointerType = 'touch') => {
  fireEvent.pointerDown(sheet, {
    pointerType,
    pointerId: 1,
    clientX: 100,
    clientY: 50,
    timeStamp: 0,
  });
  fireEvent.pointerMove(sheet, { pointerType, pointerId: 1, clientX: 100 + dx, clientY: 50 });
  vi.advanceTimersByTime(ms);
  fireEvent.pointerUp(sheet, {
    pointerType,
    pointerId: 1,
    clientX: 100 + dx,
    clientY: 50,
    timeStamp: ms,
  });
};

describe('Sheet drag to close', () => {
  it('closes after a drag past 40% of the width', () => {
    const { onOpenChange, sheet } = open();
    drag(sheet, 200, 2000);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('springs back after a short, slow drag', () => {
    const { onOpenChange, sheet } = open();
    drag(sheet, 40, 2000);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('ignores a mouse drag', () => {
    const { onOpenChange, sheet } = open();
    drag(sheet, 250, 100, 'mouse');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
