import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

describe('kit index', () => {
  it('exports CopyButton', () => {
    expect(typeof kit.CopyButton).toBe('function');
  });
});
