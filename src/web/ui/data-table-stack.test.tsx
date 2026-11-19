import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './data-table.tsx';
import type { DataColumnDef } from './data-table-meta.ts';

type Row = { id: string; name: string; note: string };
const columns: DataColumnDef<Row, never>[] = [
  { header: 'Name', id: 'name', cell: ({ row }) => row.original.name },
  { header: 'Note', id: 'note', cell: ({ row }) => row.original.note },
];
const data: Row[] = [{ id: '1', name: 'Ada', note: 'x' }];

let width = 900;
const callbacks = new Set<(entries: unknown[]) => void>();
const fire = () => {
  for (const cb of callbacks) cb([]);
};
beforeEach(() => {
  width = 900;
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: (entries: unknown[]) => void) {
        callbacks.add(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  // The table wants 700 px.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).tagName === 'SECTION' ? 700 : 0;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('DataTable stacking', () => {
  it('stacks when its column is narrower than the table, and unstacks when it grows back', () => {
    render(<DataTable caption="Rows" columns={columns} data={data} getRowId={(r) => r.id} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    width = 500;
    act(() => fire());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('list', { name: 'Rows' })).toBeInTheDocument();
    width = 900;
    act(() => fire());
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
