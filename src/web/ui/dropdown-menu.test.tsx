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
  it('ignore the pointer up of the gesture that opened the menu', () => {
    const onSelect = vi.fn();
    fireEvent.pointerUp(open(onSelect));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('select on a later pointer up', () => {
    const onSelect = vi.fn();
    const item = open(onSelect);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 1000);
    fireEvent.pointerUp(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
