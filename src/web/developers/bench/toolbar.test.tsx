import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterBar, FilterSelect } from './filter-select.tsx';
import { SearchField, Toolbar } from './toolbar.tsx';
import { useBenchFilters } from './use-filters.ts';

beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
beforeEach(() => history.replaceState(null, '', '/developers/logs?status=4xx&path=pass#r1'));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

const wide = (on: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('720') ? on : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

const KEYS = ['path', 'status', 'method'] as const;
function LogsToolbar() {
  const f = useBenchFilters(KEYS, { search: 'path' });
  const [path, setPath] = useState(f.values.path ?? '');
  return (
    <Toolbar label="Filter logs" note="Kept 7 days">
      <SearchField
        label="Search paths"
        value={path}
        onChange={(v) => {
          setPath(v);
          f.set('path', v);
        }}
      />
      <FilterBar active={f.active} onClear={f.clear}>
        <FilterSelect
          label="Status"
          value={f.values.status}
          options={[
            { value: '2xx', label: '2xx' },
            { value: '4xx', label: '4xx' },
          ]}
          onChange={(v) => f.set('status', v)}
        />
        <FilterSelect
          label="Method"
          value={f.values.method}
          options={[{ value: 'GET', label: 'GET' }]}
          onChange={(v) => f.set('method', v)}
        />
      </FilterBar>
    </Toolbar>
  );
}

describe('the toolbar', () => {
  it('draws into the frame slot: search first, filters from the query, the note last', () => {
    wide(true);
    const slot = document.createElement('div');
    slot.setAttribute('data-bench-toolbar', '');
    document.body.append(slot);
    render(<LogsToolbar />);
    const bar = slot.querySelector('search');
    expect(bar?.getAttribute('aria-label')).toBe('Filter logs');
    expect(bar?.lastElementChild?.textContent).toBe('Kept 7 days');
    expect(
      (screen.getByRole('searchbox', { name: 'Search paths' }) as HTMLInputElement).value,
    ).toBe('pass');
    const status = screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement;
    expect(status.value).toBe('4xx');
    expect(status.closest('.bench-fs')?.hasAttribute('data-set')).toBe(true);
    expect(
      screen
        .getByRole('combobox', { name: 'Method' })
        .closest('.bench-fs')
        ?.hasAttribute('data-set'),
    ).toBe(false);
  });

  it('sets and clears filters in the query in place; Clear keeps the search and the selection', () => {
    wide(true);
    const before = history.length;
    render(<LogsToolbar />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), {
      target: { value: 'GET' },
    });
    expect(new URLSearchParams(location.search).get('method')).toBe('GET');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(location.search).toBe('?path=pass');
    expect(location.hash).toBe('#r1');
    expect(history.length).toBe(before);
    // Nothing set: no Clear.
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('/ focuses the search from anywhere; Esc in it clears it', () => {
    wide(true);
    render(<LogsToolbar />);
    const search = screen.getByRole('searchbox', { name: 'Search paths' }) as HTMLInputElement;
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(search);
    // Typing a slash in the field is a slash.
    expect(fireEvent.keyDown(search, { key: '/' })).toBe(true);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(new URLSearchParams(location.search).get('path')).toBeNull();
  });

  it('below 720 px keeps only "Filters (n)", which opens the filters in a sheet', () => {
    wide(false);
    render(<LogsToolbar />);
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    const open = screen.getByRole('button', { name: 'Filters (1)' });
    expect(open.hasAttribute('data-set')).toBe(true);
    fireEvent.click(open);
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    expect(sheet.querySelectorAll('select')).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
