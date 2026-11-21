import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

describe('CommandPalette empty', () => {
  it('shows the buddy searching with its lens when nothing matches', async () => {
    render(<Palette groups={[{ heading: 'Organizations', items: [] }]} query="zzz" />);
    expect(await screen.findByText('No results')).toBeInTheDocument();
    const art = document.querySelector('[role="dialog"] svg[data-art="wallet"]');
    expect(art).toHaveAttribute('data-state', 'lost');
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art?.querySelector('[data-part="w"]')).toHaveAttribute('data-mood', 'curious');
  });
});

describe('CommandPalette preview, banner and new tab', () => {
  const rich = (id: string, newTab?: () => void) => ({ ...item(id), newTab });

  it('shows the preview of the selected row beside the list, and follows the selection', async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query="x"
        onQueryChange={() => {}}
        groups={[{ heading: 'Things', items: [item('A'), item('B')] }]}
        preview={(id) => <p>about {id}</p>}
      />,
    );
    const pane = screen.getByRole('complementary', { name: 'Preview' });
    expect(pane).toHaveTextContent('about A');
    await user.keyboard('{ArrowDown}');
    expect(pane).toHaveTextContent('about B');
  });

  it('has no preview pane unless asked, and drops it when the preview is empty', () => {
    const { rerender } = render(<Palette groups={[{ heading: 'Things', items: [item('A')] }]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    rerender(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query="x"
        onQueryChange={() => {}}
        groups={[{ heading: 'Things', items: [item('A')] }]}
        preview={() => null}
      />,
    );
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('runs newTab on ⌘↵ and shows the key only while a row has one', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const select = vi.fn();
    const { rerender } = render(
      <Palette
        groups={[{ heading: 'Things', items: [{ ...rich('A', open), onSelect: select }] }]}
      />,
    );
    expect(screen.getByText('new tab')).toBeInTheDocument();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    rerender(<Palette groups={[{ heading: 'Things', items: [item('A')] }]} />);
    expect(screen.queryByText('new tab')).toBeNull();
  });

  it('renders the banner under the input, the footer hint and custom row content', () => {
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query="x"
        onQueryChange={() => {}}
        groups={[
          {
            heading: 'Things',
            items: [{ ...item('A'), content: <b>marked</b>, hint: <i>mono</i> }],
          },
        ]}
        banner={<p role="status">careful</p>}
        hint="Paste an id"
        inputAttributes={{ spellCheck: false, autoComplete: 'off' }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('careful');
    expect(screen.getByText('Paste an id')).toBeInTheDocument();
    expect(screen.getByText('marked')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('spellcheck', 'false');
  });

  it('lets the caller word the empty block, or drop it', () => {
    const { rerender } = render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query="zzz"
        onQueryChange={() => {}}
        groups={[]}
        emptyLabel="No results for “zzz”"
      />,
    );
    expect(screen.getByText('No results for “zzz”')).toBeInTheDocument();
    rerender(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query="zzz"
        onQueryChange={() => {}}
        groups={[]}
        emptyLabel={null}
      />,
    );
    expect(screen.queryByText(/No results/)).toBeNull();
  });
});
