import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { dialogOpen } from './focus.ts';

describe('dialogOpen', () => {
  it.each([
    ['dialog', <div key="a" role="dialog" data-state="open" />],
    ['alert dialog', <div key="b" role="alertdialog" />],
    ['menu', <div key="c" role="menu" data-state="open" />],
    ['listbox of a select', <div key="d" role="listbox" data-state="open" />],
  ])('is true with an open %s (L6)', (_name, element) => {
    const { unmount } = render(element);
    expect(dialogOpen()).toBe(true);
    unmount();
    expect(dialogOpen()).toBe(false);
  });

  it('leaves the search results listbox alone: it has no open state', () => {
    const { unmount } = render(<div role="listbox" />);
    expect(dialogOpen()).toBe(false);
    unmount();
  });
});
