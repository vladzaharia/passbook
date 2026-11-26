import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../lib/api.ts', async (orig) => ({
  ...(await orig<object>()),
  api: { post: m.post, get: vi.fn() },
}));
vi.mock('../../ui/index.ts', async (orig) => ({ ...(await orig<object>()), toast: m.toast }));
vi.mock('../settings/use-org-time-zone.ts', () => ({
  useOrgTimeZone: () => 'America/Los_Angeles',
}));

import { printsBulk } from '../../../shared/operations/kinds/prints-bulk.ts';
import { fixtureOperation } from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import { useBulkPrint } from './bulk-print.tsx';

const def = {
  kind: printsBulk.kind,
  title: printsBulk.title,
  doneTitle: printsBulk.doneTitle,
  failTitle: printsBulk.failTitle,
  steps: printsBulk.steps.map((s) => ({ key: s.key, label: s.label, active: s.active })),
};

function Harness(props: { ids: string[]; orgId: string | undefined; disabled: boolean }) {
  const print = useBulkPrint(props);
  return (
    <>
      <button type="button" disabled={print.off} title={print.title} onClick={print.run}>
        Print
      </button>
      {print.panel}
    </>
  );
}
const props = { ids: ['a', 'b'], orgId: 'o1' as string | undefined, disabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  resetOperationCache();
});
afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', etag: '"op:1"' },
        }),
    ),
  );

describe('bulk Print', () => {
  it('is off without an organization, while disabled, and over the cap', () => {
    const { rerender } = render(<Harness {...props} orgId={undefined} />);
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    rerender(<Harness {...props} disabled />);
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    rerender(<Harness {...props} ids={Array.from({ length: 5000 }, (_, i) => String(i))} />);
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
  });

  it('says so when nothing can be printed, and reports a refused start', async () => {
    m.post.mockResolvedValueOnce({ count: 0, skipped: [], jobId: '', operationId: null });
    render(<Harness {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(m.toast.warning).toHaveBeenCalled());
    m.post.mockRejectedValueOnce(new Error('no'));
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(m.toast.error).toHaveBeenCalled());
    expect(m.toast.error.mock.calls[0]?.[1]).toBe('Could not print');
  });

  it('shows the job live, with its count, and no poll of its own', async () => {
    m.post.mockResolvedValue({ count: 2, skipped: [], jobId: 'j1', operationId: 'op-1' });
    answer(
      fixtureOperation(def, {
        status: 'running',
        at: 'pages',
        counts: { done: 1, total: 2 },
        id: 'op-1',
      }),
    );
    render(<Harness {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Print' }));
    expect(await screen.findByText('Preparing tickets · 1 of 2')).toBeInTheDocument();
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it('offers the PDF when it is done, fetched with the mode header', async () => {
    m.post.mockResolvedValue({ count: 2, skipped: [], jobId: 'j1', operationId: 'op-1' });
    const done = {
      ...fixtureOperation(def, { status: 'succeeded', id: 'op-1' }),
      result: { href: null, ids: { jobId: 'j1', count: '2', skipped: '0', lossy: '0' } },
    };
    answer(done);
    render(<Harness {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    const download = await screen.findByRole('button', { name: 'Download' });
    expect(screen.getByText('2 tickets ready')).toBeInTheDocument();
    const pdf = vi.fn(async (_url: string) => new Response('pdf'));
    vi.stubGlobal('fetch', pdf);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }),
    );
    await user.click(download);
    await waitFor(() => expect(pdf).toHaveBeenCalled());
    expect(pdf.mock.calls[0]?.[0]).toContain('/bulk-print/j1/pdf?orgId=o1');
  });
});
