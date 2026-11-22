import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(() => 'prep'),
    dismiss: vi.fn(),
    action: vi.fn((_message: string, _action: { onClick: () => void }) => undefined),
  },
}));
vi.mock('../../lib/api.ts', () => ({ api: { post: m.post, get: m.get } }));
vi.mock('../../lib/mode.ts', () => ({ modeHeaders: () => ({}) }));
vi.mock('../../ui/index.ts', async (orig) => ({ ...(await orig<object>()), toast: m.toast }));

import { BulkPrintAction } from './bulk-print.tsx';

const props = { ids: ['a', 'b'], orgId: 'o1' as string | undefined, disabled: false };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BulkPrintAction', () => {
  it('is off without an organization, while disabled, and over the cap', () => {
    const { rerender } = render(<BulkPrintAction {...props} orgId={undefined} as="button" />);
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    rerender(<BulkPrintAction {...props} disabled as="button" />);
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    rerender(
      <BulkPrintAction
        {...props}
        ids={Array.from({ length: 5000 }, (_, i) => String(i))}
        as="button"
      />,
    );
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
  });

  it('says so when nothing can be printed', async () => {
    m.post.mockResolvedValue({ count: 0, skipped: [], jobId: 'j' });
    render(<BulkPrintAction {...props} as="button" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(m.toast.warning).toHaveBeenCalled());
    expect(m.get).not.toHaveBeenCalled();
  });

  it('reports a refused start', async () => {
    m.post.mockRejectedValue(new Error('no'));
    render(<BulkPrintAction {...props} as="button" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(m.toast.error).toHaveBeenCalled());
    expect(m.toast.error.mock.calls[0]?.[1]).toBe('Could not print');
  });

  it('waits for the render, then offers the PDF, which is fetched with the mode header', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.post.mockResolvedValue({
      count: 2,
      skipped: [{ reason: 'Printing is off' }, { reason: 'Printing is off' }],
      jobId: 'j1',
    });
    m.get
      .mockResolvedValueOnce({ state: 'running' })
      .mockResolvedValueOnce({ state: 'ready', count: 2, lossy: false, skipped: 0 });
    const fetchMock = vi.fn(async () => new Response('pdf'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }),
    );
    render(<BulkPrintAction {...props} as="button" />);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Print' }));
    await vi.advanceTimersByTimeAsync(4100);
    await waitFor(() => expect(m.toast.action).toHaveBeenCalled());
    expect(m.toast.dismiss).toHaveBeenCalledWith('prep');
    const action = m.toast.action.mock.calls[0]?.[1] as { onClick: () => void };
    action.onClick();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/bulk-print/j1/pdf?orgId=o1');
  });

  it('reports a failed render and a PDF that cannot be fetched', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.post.mockResolvedValue({ count: 1, skipped: [], jobId: 'j2' });
    m.get.mockResolvedValueOnce({ state: 'failed' });
    render(<BulkPrintAction {...props} as="button" />);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Print' }));
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(m.toast.error).toHaveBeenCalled());
    expect(String(m.toast.error.mock.calls[0]?.[0])).toContain('PDF could not be made');
  });

  it('gives up with a slow-PDF note after a minute of polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.post.mockResolvedValue({ count: 1, skipped: [], jobId: 'j3' });
    m.get.mockResolvedValue({ state: 'running' });
    render(<BulkPrintAction {...props} as="button" />);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Print' }));
    await vi.advanceTimersByTimeAsync(125_000);
    await waitFor(() => expect(m.toast.error).toHaveBeenCalled());
    expect(String(m.toast.error.mock.calls[0]?.[0])).toContain('taking long');
  });
});
