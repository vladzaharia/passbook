import { onlineManager } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorMessage } from '../lib/errors.ts';
import { removeWithTransition, useInsertHighlight } from '../lib/motion.ts';
import { mutationButton } from '../lib/online.ts';
import '../lib/test-utils.tsx';
import { EmailList } from './email-list.tsx';
import { ErrorState, isChunkLoadError } from './error-state.tsx';
import { InlineAddField } from './inline-add-field.tsx';
import { ListRow, ListRows, RowActions } from './list-row.tsx';
import { OfflineBanner } from './offline-banner.tsx';
import { SessionList } from './session-list.tsx';
import { TooltipProvider } from './tooltip.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ListRow and RowActions', () => {
  it('truncates the title, keeps pills and trailing controls from shrinking', () => {
    const { container } = render(
      <ListRows>
        <ListRow
          title="A long title"
          pills={<span>Pill</span>}
          meta="Meta"
          trailing={<button type="button">Act</button>}
        />
      </ListRows>,
    );
    const li = container.querySelector('li');
    expect(li?.className).toContain('min-h-11');
    expect(within(li as HTMLElement).getByText('A long title').className).toContain('truncate');
    expect(screen.getByText('Pill').parentElement?.className).toContain('shrink-0');
    expect(screen.getByText('Act').parentElement?.className).toContain('ml-auto');
  });

  it('shows one safe action as a button, one destructive as an icon button, more in a menu', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <RowActions label="Row" actions={[{ label: 'Resend', icon: Mail, onSelect }]} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Resend' })).toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <RowActions
          label="Row"
          actions={[{ label: 'Remove', icon: Mail, onSelect, destructive: true }]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Remove' }).querySelector('svg')).not.toBeNull();
    rerender(
      <TooltipProvider>
        <RowActions
          label="Row"
          actions={[
            { label: 'Remove', icon: Mail, onSelect, destructive: true },
            { label: 'Resend', icon: Mail, onSelect },
          ]}
        />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Row' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Resend', 'Remove']);
  });
});

describe('InlineAddField', () => {
  it('keeps the button beside the input and puts errors under the input only', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Harness() {
      const [v, setV] = useState('');
      return (
        <InlineAddField
          label="Add email"
          value={v}
          onChange={setV}
          onSubmit={onSubmit}
          error="Enter a valid email."
        />
      );
    }
    const { container } = render(<Harness />);
    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(screen.getByText('Enter a valid email.').className).toContain('col-start-1');
    expect(screen.getByLabelText('Add email')).toHaveAccessibleDescription('Enter a valid email.');
    await user.type(screen.getByLabelText('Add email'), 'a@b.co{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('a@b.co');
  });
});

describe('EmailList', () => {
  const noop = () => {};
  it('shows pills, a pending line and the add row last', () => {
    render(
      <TooltipProvider>
        <EmailList
          items={[
            { email: 'ada@example.com', primary: true, verified: true, pending: false },
            { email: 'new@example.com', primary: false, verified: false, pending: true },
          ]}
          onAdd={noop}
          onRemove={noop}
          onMakePrimary={noop}
          onResend={noop}
          onCancelPending={noop}
        />
      </TooltipProvider>,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText('Primary')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Check your inbox')).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByLabelText('Add email')).toBeInTheDocument();
  });

  it('shows one muted line when empty, then the add row', () => {
    render(
      <TooltipProvider>
        <EmailList
          items={[]}
          onAdd={noop}
          onRemove={noop}
          onMakePrimary={noop}
          onResend={noop}
          onCancelPending={noop}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('No emails')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('SessionList', () => {
  it('puts the This device pill where Revoke sits and shows the device icon', async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
    const { container } = render(
      <SessionList
        onRevoke={onRevoke}
        items={[
          { id: 's1', userAgent: iphone, current: true, lastSeenAt: 1, createdAt: 1 },
          {
            id: 's2',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Chrome/120 Safari/537',
            current: false,
            lastSeenAt: 1,
            createdAt: 1,
            method: 'Polaris ID',
          },
        ]}
      />,
    );
    const rows = container.querySelectorAll('li');
    expect(rows[0]?.querySelector('.ml-auto')?.textContent).toBe('This device');
    expect(rows[0]?.querySelector('.ml-auto svg')?.getAttribute('class')).toContain(
      'lucide-smartphone',
    );
    expect(rows[1]?.textContent).toContain('Chrome on macOS');
    expect(rows[1]?.textContent).toContain('Polaris ID');
    await user.click(screen.getByRole('button', { name: 'Revoke Chrome on macOS' }));
    expect(onRevoke).toHaveBeenCalledWith('s2');
  });
});

describe('motion helpers', () => {
  it('marks only ids new since the previous render, never on first load', () => {
    const { result, rerender } = renderHook(({ ids }) => useInsertHighlight(ids), {
      initialProps: { ids: [] as string[] },
    });
    rerender({ ids: ['a', 'b'] });
    expect([...result.current]).toEqual([]);
    rerender({ ids: ['c', 'a', 'b'] });
    expect([...result.current]).toEqual(['c']);
    rerender({ ids: ['c', 'a', 'b'] });
    expect([...result.current]).toEqual(['c']);
  });

  it('updates at once without View Transitions', () => {
    const update = vi.fn();
    removeWithTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it('names rows for a removal View Transition and clears them after', async () => {
    let finish: () => void = () => {};
    const start = vi.fn((arg: { update: () => void } | (() => void)) => {
      (typeof arg === 'function' ? arg : arg.update)();
      return { finished: new Promise<void>((r) => (finish = r)) };
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    Object.assign(document, { startViewTransition: start });
    vi.stubGlobal('CSS', { supports: () => true, escape: (s: string) => s });
    document.body.innerHTML = '<ul><li data-row-id="r1"></li><li data-row-id="r2"></li></ul>';
    const row = document.querySelector<HTMLElement>('[data-row-id="r1"]');
    removeWithTransition(() => {
      expect(row?.style.getPropertyValue('view-transition-name')).toBe('row-r1');
      expect(document.documentElement.dataset.removing).toBe('');
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ types: ['row'] }));
    finish();
    await waitFor(() => expect(row?.style.getPropertyValue('view-transition-name')).toBe(''));
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    document.body.innerHTML = '';
  });
});

describe('ErrorState and offline', () => {
  it('maps an unreadable response to one sentence and hides the request id under Details', () => {
    const error = new ApiError({ status: 502, code: 'invalid_response', requestId: 'req-1' });
    expect(errorMessage(error)).toBe('Could not read the response. Reload.');
    const { container } = render(<ErrorState error={error} onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the response. Reload.');
    expect(container.querySelector('[data-art="unplugged"]')).not.toBeNull();
    expect(container.querySelector('details')).toHaveTextContent('Request req-1');
    expect(container.firstElementChild?.className).toContain('bg-surface-raised');
  });

  it('seats the sad buddy beside the pulled plug; inline keeps the small art alone', () => {
    const error = new ApiError({ status: 500, code: 'server_error' });
    const page = render(<ErrorState error={error} onRetry={() => {}} />).container;
    expect(page.querySelector('[data-buddy] [data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    expect(page.querySelector('[data-buddy] [data-art="unplugged"]')).not.toBeNull();
    const inline = render(<ErrorState inline error={error} onRetry={() => {}} />).container;
    expect(inline.querySelector('[data-buddy]')).toBeNull();
    expect(inline.querySelector('[data-art="unplugged"]')).not.toBeNull();
  });

  it('shakes the art only when a retry fails again', () => {
    const first = new ApiError({ status: 500, code: 'server_error' });
    const { container, rerender } = render(<ErrorState error={first} onRetry={() => {}} />);
    expect(container.querySelector('[data-shake]')).toBeNull();
    rerender(
      <ErrorState error={new ApiError({ status: 500, code: 'server_error' })} onRetry={() => {}} />,
    );
    expect(container.querySelector('svg[data-shake]')).not.toBeNull();
  });

  it('recognises chunk-load failures', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /x.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });

  it('shows Offline while the browser is offline and pauses mutations', async () => {
    render(<OfflineBanner />);
    expect(screen.queryByText('Offline')).toBeNull();
    act(() => onlineManager.setOnline(false));
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(mutationButton({ isPending: true, isPaused: true })).toEqual({
      loading: false,
      paused: true,
    });
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(screen.queryByText('Offline')).toBeNull());
  });
});
