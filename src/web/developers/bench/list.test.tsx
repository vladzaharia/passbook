import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BenchList } from './list.tsx';
import { toneOfStatus } from './status-chip.tsx';
import { type BenchSelection, useBenchSelection } from './use-selection.ts';

interface Call {
  id: string;
  path: string;
  status: number;
}
const CALLS: Call[] = [
  { id: 'r1', path: '/passes', status: 200 },
  { id: 'r2', path: '/passes?limit=abc', status: 422 },
  { id: 'r3', path: '/templates', status: 500 },
];
const idOf = (c: Call) => c.id;

let seen: BenchSelection<Call> | undefined;
function Logs({
  items = CALLS,
  fetchOne,
  fresh,
}: {
  items?: Call[];
  fetchOne?: (id: string) => Promise<Call | null>;
  fresh?: Set<string>;
}) {
  const selection = useBenchSelection({ items, idOf, fetchOne });
  seen = selection;
  return (
    <BenchList
      label="Requests"
      items={items}
      idOf={idOf}
      row={(c) => ({ lead: '14:15:53', title: c.path, trail: c.status })}
      tone={(c) => toneOfStatus(c.status)}
      selection={selection}
      fresh={fresh}
      footer={{ count: `${items.length} requests`, onMore: () => undefined }}
    />
  );
}

beforeEach(() => history.replaceState(null, '', '/developers/logs?status=4xx'));
afterEach(() => {
  cleanup();
  seen = undefined;
  history.replaceState(null, '', '/');
});

const box = () => screen.getByRole('listbox', { name: 'Requests' });
const active = () => box().getAttribute('aria-activedescendant');
const option = (path: string) => {
  const found = screen
    .getAllByRole('option')
    .find((o) => o.querySelector('.bench-row-tt')?.textContent === path);
  if (!found) throw new Error(`no row ${path}`);
  return found;
};

describe('the bench list', () => {
  it('is one Tab stop whose arrows, j and k, Home and End move the selection, written to the hash in place', () => {
    const before = history.length;
    render(<Logs />);
    expect(box().tabIndex).toBe(0);
    expect(screen.getAllByRole('option').every((o) => o.tabIndex === -1)).toBe(true);
    expect(active()).toBeNull();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(location.hash).toBe('#r1');
    expect(active()).toBe(option('/passes').id);
    fireEvent.keyDown(box(), { key: 'j' });
    expect(location.hash).toBe('#r2');
    expect(option('/passes?limit=abc').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box(), { key: 'End' });
    expect(location.hash).toBe('#r3');
    fireEvent.keyDown(box(), { key: 'k' });
    expect(location.hash).toBe('#r2');
    fireEvent.keyDown(box(), { key: 'Home' });
    expect(location.hash).toBe('#r1');
    // The filters stay; nothing was pushed: Back steps through tools, not rows.
    expect(location.search).toBe('?status=4xx');
    expect(history.length).toBe(before);
    // Moving selects without opening; Enter opens.
    expect(seen?.open).toBe(false);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(seen?.open).toBe(true);
  });

  it('opens on a press, ticks each row in its status tone, and counts in the footer', () => {
    render(<Logs fresh={new Set(['r3'])} />);
    fireEvent.click(option('/templates'));
    expect(location.hash).toBe('#r3');
    expect(seen?.open).toBe(true);
    expect(document.activeElement).toBe(box());
    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.dataset.tone)).toEqual(['success', 'warning', 'danger']);
    expect(rows.map((r) => 'fresh' in r.dataset)).toEqual([false, false, true]);
    expect(screen.getByText('3 requests')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('selects and opens the row a link names, and follows the hash when it changes', () => {
    history.replaceState(null, '', '/developers/logs#r2');
    render(<Logs />);
    expect(option('/passes?limit=abc').getAttribute('aria-selected')).toBe('true');
    expect(seen?.open).toBe(true);
    act(() => {
      history.replaceState(null, '', '/developers/logs#r3');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(option('/templates').getAttribute('aria-selected')).toBe('true');
  });

  it('pins an item the list does not hold, read once by id, and steps from it', async () => {
    history.replaceState(null, '', '/developers/logs#old');
    const fetchOne = vi.fn(async (id: string) => ({ id, path: '/old', status: 404 }));
    render(<Logs fetchOne={fetchOne} />);
    await waitFor(() => expect(screen.getByText('Not in this view')).toBeTruthy());
    expect(fetchOne).toHaveBeenCalledTimes(1);
    const pinned = option('/old');
    expect(pinned.dataset.pinned).toBe('');
    expect(pinned.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(location.hash).toBe('#r1');
    // Picked away from it, the pin goes.
    expect(screen.queryByText('Not in this view')).toBeNull();
  });

  it('shows the empty state in place of the rows', () => {
    render(
      <BenchList
        label="Requests"
        items={[] as Call[]}
        idOf={idOf}
        row={(c) => ({ title: c.path })}
        selection={{ selectedId: null, selected: null, pinned: null, open: false, select: vi.fn(), step: vi.fn(), setOpen: vi.fn() }}
        empty={<p>No requests yet.</p>}
      />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('No requests yet.')).toBeTruthy();
  });
});
