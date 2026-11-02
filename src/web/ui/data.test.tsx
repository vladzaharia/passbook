import type { ColumnDef } from '@tanstack/react-table';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ApiError } from '../lib/errors.ts';
import '../lib/test-utils.tsx';
import { CodeBlock, JsonViewer } from './code-block.tsx';
import { CopyButton } from './copy-button.tsx';
import { DataTable } from './data-table.tsx';
import { DiffViewer } from './diff-viewer.tsx';
import { EmptyState, FilteredEmpty } from './empty-state.tsx';
import { ErrorState } from './error-state.tsx';
import { FileDrop } from './file-drop.tsx';
import { KeyValue } from './key-value.tsx';
import { PageHeader } from './page-header.tsx';
import { LoadMore } from './pagination.tsx';
import { SkeletonRows } from './skeleton.tsx';
import { Timeline } from './timeline.tsx';
import { TooltipProvider } from './tooltip.tsx';

afterEach(() => vi.unstubAllGlobals());

interface Row {
  id: string;
  name: string;
  count: number;
}
const ROWS: Row[] = [
  { id: '1', name: 'Bravo', count: 2 },
  { id: '2', name: 'Alpha', count: 3 },
  { id: '3', name: 'Charlie', count: 1 },
];
const COLUMNS: ColumnDef<Row, never>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'count', header: 'Count' },
  { id: 'actions', header: 'Actions', cell: () => 'x' },
];

const names = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent);

describe('DataTable', () => {
  it('renders an accessible table without violations', async () => {
    const { container } = render(
      <DataTable caption="Passes" columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />,
    );
    expect(screen.getByRole('table', { name: 'Passes' })).toBeInTheDocument();
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('lists rows in server order with no sort controls', () => {
    render(<DataTable caption="Passes" columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />);
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
  });

  it('renders the filtered empty state with the toolbar, and hides the toolbar when truly empty', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const toolbar = <search>toolbar</search>;
    const { rerender } = render(
      <DataTable
        caption="Passes"
        columns={COLUMNS}
        data={[]}
        filtered
        toolbar={toolbar}
        empty={<EmptyState art="passes" title="No passes yet" />}
        emptyFiltered={<FilteredEmpty entity="pass" onClear={onClear} />}
      />,
    );
    expect(screen.getByText('No passes match')).toBeInTheDocument();
    expect(screen.getByText('toolbar')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalled();
    rerender(
      <DataTable
        caption="Passes"
        columns={COLUMNS}
        data={[]}
        toolbar={toolbar}
        empty={<EmptyState art="passes" title="No passes yet" />}
        emptyFiltered={<FilteredEmpty entity="pass" onClear={onClear} />}
      />,
    );
    expect(screen.getByText('No passes yet')).toBeInTheDocument();
    expect(screen.queryByText('toolbar')).toBeNull();
  });

  it('keeps rows on a refetch, then dims them and runs the rail after 150 ms', async () => {
    const { container } = render(
      <DataTable caption="Passes" columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} fetching />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(container.querySelector('.wl-rail')).not.toBeNull();
  });

  it('marks rows new since the last render, never on first load', () => {
    const { container, rerender } = render(
      <DataTable caption="Passes" columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />,
    );
    expect(container.querySelectorAll('[data-new]')).toHaveLength(0);
    rerender(
      <DataTable
        caption="Passes"
        columns={COLUMNS}
        data={[...ROWS, { id: '4', name: 'Delta', count: 0 }]}
        getRowId={(r) => r.id}
      />,
    );
    const fresh = container.querySelectorAll('[data-new]');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toHaveAttribute('data-row-id', '4');
  });

  it('shows the empty node, the loading skeleton, and rows over a stale load', () => {
    const { rerender } = render(
      <DataTable
        caption="Passes"
        columns={COLUMNS}
        data={[]}
        empty={<EmptyState art="passes" title="No passes" />}
      />,
    );
    expect(screen.getByText('No passes')).toBeInTheDocument();
    rerender(
      <DataTable
        caption="Passes"
        columns={COLUMNS}
        data={[]}
        loading
        empty={<EmptyState art="passes" title="No passes" />}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading Passes');
    rerender(<DataTable caption="Passes" columns={COLUMNS} data={ROWS} loading />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('calls onRowClick with the row', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable caption="Passes" columns={COLUMNS} data={ROWS} onRowClick={onRowClick} />);
    await user.click(screen.getByText('Alpha'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });
});

describe('LoadMore', () => {
  it('shows the button only when more is available', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <LoadMore hasMore shown={50} noun={['pass', 'passes']} onLoadMore={onLoadMore} />,
    );
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.getByText('50 passes')).toBeInTheDocument();
    rerender(
      <LoadMore hasMore={false} shown={1} noun={['pass', 'passes']} onLoadMore={onLoadMore} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('1 pass')).toBeInTheDocument();
  });

  it('disables while loading', () => {
    render(<LoadMore hasMore loading onLoadMore={() => {}} />);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
  });
});

describe('states', () => {
  it('ErrorState explains, shows the request id and retries', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = render(
      <ErrorState
        error={new ApiError({ status: 500, code: 'server_error', requestId: 'req-9' })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Server error. Try again.');
    expect(screen.getByText('Request req-9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('EmptyState and SkeletonRows have no violations', async () => {
    const { container } = render(
      <div>
        <EmptyState art="passes" title="Nothing here" description="Create one." />
        <SkeletonRows rows={2} />
      </div>,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('KeyValue, Timeline', () => {
  it('KeyValue renders a definition list and a fallback for null values', async () => {
    const { container } = render(
      <KeyValue
        items={[
          { label: 'Serial', value: 'abc', mono: true },
          { label: 'Owner', value: null },
        ]}
      />,
    );
    expect(screen.getByText('Serial').tagName).toBe('DT');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Timeline lists items in order with machine-readable times', async () => {
    const { container } = render(
      <Timeline
        items={[
          { id: 'a', title: 'Created', time: Date.UTC(2026, 0, 2) },
          { id: 'b', title: 'Voided', time: 'yesterday', tone: 'danger' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Timeline takes glyph and tone from the action and highlights new entries', () => {
    const at = Date.UTC(2026, 0, 2);
    const first = [
      { id: 'a', action: 'auth.sign_in', time: at },
      { id: 'b', action: 'api_key.create', time: at },
    ];
    const { container, rerender } = render(<Timeline items={first} />);
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    const glyphs = [...container.querySelectorAll('li > span:nth-child(2) svg')].map((s) =>
      s.getAttribute('class'),
    );
    expect(glyphs[0]).not.toEqual(glyphs[1]);
    expect(container.querySelectorAll('.wl-tl-new')).toHaveLength(0);
    rerender(<Timeline items={[{ id: 'c', action: 'pass.void', time: at }, ...first]} />);
    const fresh = container.querySelectorAll('.wl-tl-new');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toHaveTextContent('Pass voided');
  });
});

describe('CopyButton, CodeBlock, JsonViewer', () => {
  it('copies and announces', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <TooltipProvider>
        <CopyButton value="secret-link" label="Copy link" />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('secret-link');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('reports failure when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    render(
      <TooltipProvider>
        <CopyButton value="x" />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copy failed'));
  });

  it('CodeBlock and JsonViewer are labelled, focusable regions', async () => {
    const { container } = render(
      <TooltipProvider>
        <CodeBlock code="curl x" label="Request" />
        <JsonViewer value={{ a: 1 }} label="Payload" />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText('Request')).toHaveAttribute('tabindex', '0');
    expect(screen.getByLabelText('Payload')).toHaveTextContent('"a": 1');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('DiffViewer', () => {
  it('describes additions and removals in text, not only colour', async () => {
    const { container } = render(<DiffViewer before={'a\nb'} after={'a\nc'} />);
    expect(screen.getByText('Removed:')).toBeInTheDocument();
    expect(screen.getByText('Added:')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says so when there are no changes', () => {
    render(<DiffViewer before="same" after="same" />);
    expect(screen.getByText('No changes')).toBeInTheDocument();
  });
});

describe('FileDrop', () => {
  const file = (name: string, size = 3, type = '') =>
    new File([new Uint8Array(size)], name, { type });

  it('accepts a matching file and resets the input', async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    const { container } = render(
      <FileDrop onFiles={onFiles} accept=".zip,image/*" label="Choose template" />,
    );
    await user.upload(screen.getByLabelText('Choose template'), file('t.zip'));
    expect(onFiles).toHaveBeenCalledOnce();
    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('rejects an unsupported type with an alert', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onFiles = vi.fn();
    render(<FileDrop onFiles={onFiles} accept=".zip" label="Choose" />);
    await user.upload(screen.getByLabelText('Choose'), file('evil.exe'));
    expect(screen.getByRole('alert')).toHaveTextContent('evil.exe: unsupported type.');
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('rejects oversized files', async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<FileDrop onFiles={onFiles} maxBytes={1024} label="Choose" />);
    await user.upload(screen.getByLabelText('Choose'), file('big.bin', 4096));
    expect(screen.getByRole('alert')).toHaveTextContent('big.bin: larger than 1 KB.');
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('keeps only the first file unless multiple', async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<FileDrop onFiles={onFiles} multiple label="Choose" />);
    await user.upload(screen.getByLabelText('Choose'), [file('a.txt'), file('b.txt')]);
    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(2);
  });
});

describe('PageHeader', () => {
  it('renders the h1 and sets the document title', () => {
    render(
      <PageHeader
        title="Templates"
        description="Pass layouts"
        actions={<button type="button">New</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Templates' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    expect(document.title).toBe('Templates · PassBook');
  });
});
