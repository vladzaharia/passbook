import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu.tsx';

afterEach(() => vi.restoreAllMocks());

function open(onSelect: () => void) {
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelect}>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return screen.getByRole('menuitem', { name: 'Remove' });
}

describe('dropdown menu items', () => {
  it('ignore a touch pointer up right after opening', () => {
    const onSelect = vi.fn();
    fireEvent.pointerUp(open(onSelect), { pointerType: 'touch' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('select a mouse press-drag-release at once', () => {
    const onSelect = vi.fn();
    fireEvent.pointerUp(open(onSelect), { pointerType: 'mouse' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('select a touch pointer up after the window', () => {
    const onSelect = vi.fn();
    const item = open(onSelect);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 1000);
    fireEvent.pointerUp(item, { pointerType: 'touch' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('select on click right after opening', () => {
    const onSelect = vi.fn();
    fireEvent.click(open(onSelect));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('select on Enter right after opening', () => {
    const onSelect = vi.fn();
    const item = open(onSelect);
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('the opening gesture', () => {
  const touch = (pointerId: number) => ({ pointerType: 'touch', pointerId });
  /** The press that opens the menu lands on the page before the items mount. */
  const openedBy = (pointerId: number, onSelect: () => void) => {
    fireEvent.pointerDown(document.body, touch(pointerId));
    return open(onSelect);
  };

  it('ignores its pointer up by pointerId, however late', () => {
    const onSelect = vi.fn();
    const item = openedBy(11, onSelect);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 5000);
    fireEvent.pointerUp(item, touch(11));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores the click that follows it', () => {
    const onSelect = vi.fn();
    const item = openedBy(12, onSelect);
    fireEvent.pointerUp(document.body, touch(12));
    fireEvent.click(item, { detail: 1, ...touch(12) });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a click while the opening press is still down', () => {
    const onSelect = vi.fn();
    const item = openedBy(13, onSelect);
    fireEvent.click(item, { detail: 1, ...touch(13) });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects on a pointer up from another pointer', () => {
    const onSelect = vi.fn();
    const item = openedBy(14, onSelect);
    fireEvent.pointerUp(item, touch(15));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('selects a fresh press on the item, pointer up and click', () => {
    const onSelect = vi.fn();
    const item = openedBy(16, onSelect);
    fireEvent.pointerUp(document.body, touch(16));
    fireEvent.pointerDown(item, touch(17));
    fireEvent.pointerUp(item, touch(17));
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('selects a click with no pointer, as the keyboard sends', () => {
    const onSelect = vi.fn();
    const item = openedBy(18, onSelect);
    fireEvent.click(item, { detail: 0 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('selects a click long after the opening press ended', () => {
    const onSelect = vi.fn();
    const item = openedBy(19, onSelect);
    fireEvent.pointerUp(document.body, touch(19));
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2000);
    fireEvent.click(item, { detail: 1, ...touch(19) });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('dropdown menu focus', () => {
  it('makes the rest of the page inert while open and restores it on close', () => {
    const page = document.createElement('div');
    document.body.append(page);
    const { unmount } = render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <DropdownMenuItem>Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(page.inert).toBe(true);
    unmount();
    expect(page.inert).toBe(false);
    page.remove();
  });
});
