import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import '../lib/test-utils.tsx';
import { type CommandGroup, CommandPalette } from './command-palette.tsx';

const item = (id: string) => ({ id, label: id, onSelect: () => {} });
const selected = () => screen.getByRole('option', { selected: true }).textContent;

function Palette({ groups, query = 'north' }: { groups: CommandGroup[]; query?: string }) {
  return (
    <CommandPalette
      open
      onOpenChange={() => {}}
      query={query}
      onQueryChange={() => {}}
      groups={groups}
    />
  );
}

describe('CommandPalette selection', () => {
  it('keeps the first result selected as server groups land above local ones', () => {
    const orgs = { heading: 'Organizations', items: [item('Northwind Climbing')] };
    const { rerender } = render(<Palette groups={[orgs]} />);
    expect(selected()).toBe('Northwind Climbing');
    rerender(
      <Palette groups={[{ heading: 'Templates', items: [item('Northwind Member')] }, orgs]} />,
    );
    expect(selected()).toBe('Northwind Member');
  });

  it('keeps the person’s pick once they move the selection', async () => {
    const user = userEvent.setup();
    const orgs = { heading: 'Organizations', items: [item('A'), item('B')] };
    const { rerender } = render(<Palette groups={[orgs]} />);
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe('B');
    rerender(<Palette groups={[{ heading: 'Templates', items: [item('T')] }, orgs]} />);
    expect(selected()).toBe('B');
  });
});
