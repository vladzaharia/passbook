import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import * as kit from './index.ts';
import { Tabs, TabsList, TabsTrigger } from './tabs.tsx';

const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('TabsList strip', () => {
  it('snaps tabs to centre and keeps every tab at least 44 px on touch', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          {NAMES.map((n) => (
            <TabsTrigger key={n} value={n}>
              {n}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>,
    );
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('snap-x');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('snap-center');
      expect(tab.className).toContain('pointer-coarse:min-h-11');
    }
  });
});

describe('TabsList overflow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the end chevron when tabs overflow, pages on click and reveals the active tab', async () => {
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    Object.assign(HTMLElement.prototype, { scrollBy, scrollTo });
    // A 200 px strip holding 900 px of tabs.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    render(
      <Tabs defaultValue="e">
        <TabsList aria-label="Sections">
          {NAMES.map((n) => (
            <TabsTrigger key={n} value={n}>
              {n}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>,
    );
    const more = await screen.findByRole('button', { name: 'More tabs', hidden: true });
    expect(more.className).toContain('pointer-coarse:size-11');
    expect(screen.queryByRole('button', { name: 'Earlier tabs', hidden: true })).toBeNull();
    // The active tab is scrolled into view on mount.
    expect(scrollTo).toHaveBeenCalled();
    await userEvent.setup().click(more);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 140 }));
  });
});

describe('kit index', () => {
  it('exports CopyButton', () => {
    expect(typeof kit.CopyButton).toBe('function');
  });
});
