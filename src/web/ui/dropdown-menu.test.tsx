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
