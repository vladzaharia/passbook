import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { ApiError } from '../../lib/errors.ts';
import { fakeInsideApi, insideRow, rows } from './inside-fake.test-support.ts';
import { InsideSheet } from './inside-sheet.tsx';
import type { InsideRow } from './inside-types.ts';
import { useInside } from './use-inside.ts';

const notify = { undo: vi.fn(), error: vi.fn(), info: vi.fn() };

function Harness({
  api,
  online = true,
  onOpenRow = vi.fn(),
  ...rest
}: {
  api: ReturnType<typeof fakeInsideApi>;
  online?: boolean;
  onOpenRow?: (row: InsideRow) => void;
} & Partial<ComponentProps<typeof InsideSheet>>) {
  const inside = useInside({ api, active: true, online, notify });
  const [open] = useState(true);
  return (
    <InsideSheet
      open={open}
      onClose={() => undefined}
      inside={inside}
      online={online}
      onOpenRow={onOpenRow}
      {...rest}
    />
  );
}

beforeEach(() => {
  notify.undo.mockClear();
  notify.error.mockClear();
});

describe("Who's in", () => {
  it('lists people longest first with plan, zone, since and stay', async () => {
    render(<Harness api={fakeInsideApi(rows(3))} />);
    const list = await screen.findByTestId('inside-list');
    const items = within(list).getAllByTestId('inside-row');
    expect(items).toHaveLength(3);
    // rows(3): the oldest (n=2) leads.
    expect(items[0]).toHaveTextContent(String(insideRow(2).holder));
    expect(items[0]).toHaveTextContent('Floor 3, HQ · In since');
    expect(items[0]).toHaveTextContent(/\d+ (d|h|min)/);
    expect(items[0]).toHaveTextContent('Out by');
  });
  it('shows the place and its count with the capacity bar', async () => {
    render(<Harness api={fakeInsideApi(rows(3))} />);
    const place = await screen.findByRole('button', { name: /Gym/ });
    expect(place).toHaveTextContent('3/60');
    expect(place).toBeDisabled();
  });
  it('flags a long stay and a ended pass, and tints the row', async () => {
    const api = fakeInsideApi([insideRow(0, { flags: ['long_stay', 'pass_ended'] }), insideRow(1)]);
    render(<Harness api={api} />);
    const flagged = (await screen.findAllByTestId('inside-row')).find((r) => r.dataset.flag);
    expect(flagged).toHaveTextContent('Long stay');
    expect(flagged).toHaveTextContent('Pass ended');
  });
  it("shows a visitor's host", async () => {
    render(<Harness api={fakeInsideApi([insideRow(0, { host: 'Ana R.' })])} />);
    expect(await screen.findByText('Host Ana R.')).toBeVisible();
  });
  it('opens the card from a row', async () => {
    const onOpenRow = vi.fn();
    render(<Harness api={fakeInsideApi(rows(2))} onOpenRow={onOpenRow} />);
    const row = (await screen.findAllByTestId('inside-row'))[0];
    fireEvent.click(within(row as HTMLElement).getByText(String(insideRow(1).holder)));
    expect(onOpenRow).toHaveBeenCalledWith(
      expect.objectContaining({ passId: insideRow(1).passId }),
    );
  });
  it('searches by name and says when no one matches', async () => {
    render(<Harness api={fakeInsideApi(rows(4))} />);
    await screen.findByTestId('inside-list');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), {
      target: { value: 'zzz' },
    });
    expect(await screen.findByText('No one by that name', {}, { timeout: 2000 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getAllByTestId('inside-row').length).toBe(4));
  });
  it('shows the empty state', async () => {
    render(<Harness api={fakeInsideApi([])} />);
    expect(await screen.findByText('No one inside')).toBeVisible();
  });
  it('marks out: the row and the count go, and Undo is offered', async () => {
    const api = fakeInsideApi(rows(3));
    render(<Harness api={api} />);
    const first = (await screen.findAllByTestId('inside-row'))[0] as HTMLElement;
    const name = String(insideRow(2).holder);
    fireEvent.click(within(first).getByRole('button', { name: `Mark as out: ${name}` }));
    await waitFor(() => expect(screen.getAllByTestId('inside-row')).toHaveLength(2));
    expect(notify.undo).toHaveBeenCalledWith(`${name} marked as out`, expect.any(Function));
    expect(screen.getByRole('button', { name: /Gym/ })).toHaveTextContent('2/60');
  });
  it('a failed mark-out brings the row back', async () => {
    const api = fakeInsideApi(rows(2));
    api.fail.markOut = new ApiError({ status: 500, code: 'server_error' });
    render(<Harness api={api} />);
    const first = (await screen.findAllByTestId('inside-row'))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: /Mark as out/ }));
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(screen.getAllByTestId('inside-row')).toHaveLength(2);
  });
  it('offline: the list stays dimmed with As of, and Mark as out is off', async () => {
    const api = fakeInsideApi(rows(2));
    const { rerender } = render(<Harness api={api} />);
    await screen.findByTestId('inside-list');
    rerender(<Harness api={api} online={false} />);
    expect(await screen.findByText(/^As of /)).toBeVisible();
    for (const b of screen.getAllByRole('button', { name: /Mark as out/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', 'Needs a connection');
    }
    expect(screen.getByTestId('inside-sheet')).toHaveAttribute('data-stale');
  });
  it('a failed first load offers Try again', async () => {
    const api = fakeInsideApi(rows(2));
    api.fail.inside = new ApiError({ status: 500, code: 'server_error' });
    render(<Harness api={api} />);
    expect(await screen.findByText("Couldn't load the list.")).toBeVisible();
    api.fail.inside = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByTestId('inside-row')).toHaveLength(2));
  });
  it('lets roll call replace the row action and add a header and footer', async () => {
    render(
      <Harness
        api={fakeInsideApi(rows(2))}
        trailing={(row) => <button type="button">Safe {row.holder}</button>}
        header={<p>Roll call banner</p>}
        footer={<p>Roll call footer</p>}
      />,
    );
    await screen.findByTestId('inside-list');
    expect(screen.queryByRole('button', { name: /Mark as out/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Safe / })).toHaveLength(2);
    expect(screen.getByText('Roll call banner')).toBeVisible();
    expect(screen.getByText('Roll call footer')).toBeVisible();
  });
  it('removes a row at once under reduced motion', async () => {
    const api = fakeInsideApi(rows(2));
    render(<Harness api={api} />);
    const first = (await screen.findAllByTestId('inside-row'))[0] as HTMLElement;
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: /Mark as out/ }));
    });
    expect(screen.getAllByTestId('inside-row')).toHaveLength(1);
  });
});

describe('layouts', () => {
  for (const width of [390, 820, 1180]) {
    for (const theme of ['light', 'dark']) {
      it(`has no axe violations at ${width} px, ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        const api = fakeInsideApi([insideRow(0, { flags: ['long_stay'] }), insideRow(1)]);
        render(<Harness api={api} />);
        await screen.findByTestId('inside-list');
        const dialog = screen.getByRole('dialog');
        expect((await axe(dialog)).violations).toEqual([]);
        delete document.documentElement.dataset.theme;
      });
    }
  }
  it('has no axe violations when empty, searching with no match, offline or failed', async () => {
    const empty = render(<Harness api={fakeInsideApi([])} />);
    await screen.findByText('No one inside');
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
    empty.unmount();
    const failing = fakeInsideApi([]);
    failing.fail.inside = new ApiError({ status: 500, code: 'server_error' });
    render(<Harness api={failing} online={false} />);
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
