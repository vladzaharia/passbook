import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { TooltipProvider } from '../tooltip.tsx';
import { type OperationsClient, OperationsProvider } from './client.ts';
import { fixtureOperation, SANDBOX_CREATE, STATE_FIXTURES } from './fixtures.test-support.ts';
import { OperationProgress } from './operation-progress.tsx';
import { OperationTray } from './operation-tray.tsx';
import { resetOperationCache, trackOperation } from './store.ts';

const toasts = vi.hoisted(() => ({ action: vi.fn(), error: vi.fn() }));
vi.mock('../toaster.tsx', () => ({ toast: toasts, Toaster: () => null }));

function client(over: Partial<OperationsClient> = {}): OperationsClient {
  return {
    get: vi.fn(async () => ({ operation: null, etag: null })),
    list: vi.fn(async () => []),
    cancel: vi.fn(),
    retry: vi.fn(),
    ...over,
  } as OperationsClient;
}
const mount = (c: OperationsClient, ui = <OperationTray />) =>
  render(
    <OperationsProvider client={c}>
      <TooltipProvider>{ui}</TooltipProvider>
    </OperationsProvider>,
  );
const matchMedia = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce') || (phone && q.includes('max-width: 639')),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetOperationCache();
  toasts.action.mockClear();
  toasts.error.mockClear();
  matchMedia(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe('OperationTray', () => {
  it('hides when nothing runs and nothing is unseen, but keeps its live region mounted', async () => {
    const { container } = mount(client());
    await settle();
    expect(container.querySelector('[data-operation-tray]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeInTheDocument();
  });

  it('resumes what a reload left running: a badge, then the popover with the exact line', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(client({ list: vi.fn(async () => [STATE_FIXTURES.running()]) }));
    await settle();
    const button = screen.getByRole('button', { name: 'Activity, 1 running' });
    expect(button.parentElement).toHaveTextContent('1');
    await user.click(button);
    const pop = await screen.findByText('Removing Test passes · 4 of 12');
    expect(pop).toBeInTheDocument();
    expect(screen.getByText('Delete sandbox')).toBeInTheDocument();
  });

  it('takes a start mutation without a poll to find it, and polls only while it holds a running row', async () => {
    const list = vi.fn(async () => []);
    mount(client({ list }));
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    act(() => trackOperation(STATE_FIXTURES.running()));
    expect(screen.getByRole('button', { name: 'Activity, 1 running' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('is a bottom sheet below 640 px, rows at least 44 px tall on touch', async () => {
    matchMedia(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(client({ list: vi.fn(async () => [STATE_FIXTURES.running()]) }));
    await settle();
    await user.click(screen.getByRole('button', { name: 'Activity, 1 running' }));
    const sheet = await screen.findByRole('dialog', { name: 'Activity' });
    expect(sheet).toHaveClass('wl-sheet-bottom');
    expect(within(sheet).getByRole('button', { name: /Delete sandbox/ })).toHaveClass(
      'pointer-coarse:min-h-14',
    );
  });

  it('toasts an end the person did not watch, with View, and a failure with Retry', async () => {
    const op = fixtureOperation(SANDBOX_CREATE, { status: 'running', at: 'org' });
    mount(client());
    await settle();
    act(() => trackOperation(op));
    act(() =>
      trackOperation({
        ...fixtureOperation(SANDBOX_CREATE, { status: 'succeeded' }),
        id: op.id,
        revision: 9,
      }),
    );
    expect(toasts.action).toHaveBeenCalledWith(
      'Sandbox ready',
      expect.objectContaining({ label: 'View' }),
    );

    const bad = {
      ...fixtureOperation(SANDBOX_CREATE, { status: 'running', at: 'capture' }),
      id: 'bad',
    };
    act(() => trackOperation(bad));
    act(() =>
      trackOperation({
        ...fixtureOperation(SANDBOX_CREATE, { status: 'failed', at: 'capture' }),
        id: 'bad',
        revision: 9,
      }),
    );
    expect(toasts.error).toHaveBeenCalledWith(
      'Webhooks are off on this plan. Retry.',
      'Could not finish your sandbox',
      expect.objectContaining({ label: 'Retry' }),
    );
  });

  it("suppresses the toast while the operation's own panel is on screen", async () => {
    const op = fixtureOperation(SANDBOX_CREATE, { status: 'running', at: 'org' });
    const done = {
      ...fixtureOperation(SANDBOX_CREATE, { status: 'succeeded' }),
      id: op.id,
      revision: 9,
    };
    const view = mount(
      client(),
      <>
        <OperationTray />
        <OperationProgress operation={op} />
      </>,
    );
    await settle();
    act(() => trackOperation(op));
    act(() => trackOperation(done));
    expect(toasts.action).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-operation-tray]')).toBeInTheDocument();
  });
});
