import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { StepList, StepMarker } from '../step-marker.tsx';
import { TooltipProvider } from '../tooltip.tsx';
import {
  APPLE_SETUP,
  fixtureOperation,
  NOW,
  SANDBOX_CREATE,
  SANDBOX_DELETE,
  SANDBOX_RECREATE,
  SANDBOX_RESET,
  STATE_FIXTURES,
} from './fixtures.test-support.ts';
import { LocalOperation, useLocalOperation } from './local.ts';
import { OperationProgress } from './operation-progress.tsx';
import { announcement } from './steps.ts';

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

/** The headline (the live region repeats it for screen readers). */
const head = () => document.querySelector('[data-headline]');
const wrap = (ui: React.ReactNode) => <TooltipProvider>{ui}</TooltipProvider>;
const live = (c: HTMLElement) => c.querySelector('[role="status"]') as HTMLElement;
const rows = (c: HTMLElement) =>
  within(c.querySelector('ol') as HTMLElement)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('StepMarker and StepList', () => {
  it('draws waiting as a dashed clock with its word, not colour alone', () => {
    const { container } = render(
      <StepList
        label="Setup"
        items={[
          { id: 'a', label: 'Check', state: 'done' },
          { id: 'b', label: 'Issue', state: 'waiting', meta: 'Tries again in 6 h' },
        ]}
      />,
    );
    const marker = container.querySelector('[data-state="waiting"]');
    expect(marker).toHaveClass('border-dashed');
    expect(marker?.querySelector('svg')).toBeInTheDocument();
    expect(marker?.querySelector('svg')).toHaveClass('!size-3.5', '!text-current');
    expect(screen.getByText(/\(waiting\)/)).toHaveClass('sr-only');
    expect(screen.getByText('Tries again in 6 h')).toHaveClass('tabular-nums');
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('Issue');
  });

  it('heads groups and draws the tick of a step that finishes after mount', () => {
    const items = (second: 'working' | 'done') => [
      { id: 'a', label: 'Close', state: 'done' as const, group: 'Old sandbox' },
      { id: 'b', label: 'Revoke', state: second, group: undefined },
      { id: 'c', label: 'Create', state: 'todo' as const, group: 'New sandbox' },
    ];
    const { container, rerender } = render(
      <StepList label="Start over" items={items('working')} />,
    );
    expect(screen.getByText('Old sandbox')).toBeInTheDocument();
    expect(screen.getByText('New sandbox')).toBeInTheDocument();
    // Done at mount: no tick draw.
    expect(container.querySelectorAll('.wl-step-done')).toHaveLength(0);
    rerender(<StepList label="Start over" items={items('done')} />);
    expect(container.querySelectorAll('.wl-step-done')).toHaveLength(1);
  });

  it('keeps the glyph size and colour against a host rule', () => {
    const { container } = render(<StepMarker state="working" n={1} size="sm" />);
    expect(container.querySelector('svg')).toHaveClass(
      '!size-3',
      '!text-current',
      'wl-spin',
      'wl-essential',
    );
  });
});

describe('OperationProgress states', () => {
  it('queued: Starting, with Stop only when the kind allows it', () => {
    const op = { ...STATE_FIXTURES.queued(), cancelable: true };
    render(wrap(<OperationProgress operation={op} onStop={() => {}} />));
    expect(head()).toHaveTextContent('Starting');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('running: the exact step with its count, the bar, elapsed time and Run in background', () => {
    const op = STATE_FIXTURES.running();
    const { container } = render(
      wrap(<OperationProgress operation={op} onStop={() => {}} onBackground={() => {}} />),
    );
    expect(head()).toHaveTextContent('Removing Test passes · 4 of 12');
    expect(screen.getByRole('progressbar', { name: 'Remove Test passes' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    expect(screen.getByText('0:18')).toHaveAttribute('aria-hidden', 'true');
    expect(rows(container)).toEqual([
      'Close sandbox (done)',
      'Revoke keys (done)',
      'Remove Test passes (in progress)4 of 12',
      '4Erase sandbox data',
    ]);
    expect(screen.getByRole('button', { name: 'Run in background' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // The working marker keeps its spinner under reduced motion (it carries state).
    expect(container.querySelector('[data-state="working"] svg')).toHaveClass('wl-essential');
    // One buddy: it rides the bar, none sits on the panel's edge.
    expect(container.querySelectorAll('[data-scene="busy"]')).toHaveLength(1);
    expect(container.querySelector('[data-at="end"]')).toBeNull();
  });

  it('running without a count: the buddy acts busy beside the step line', () => {
    const { container } = render(
      wrap(<OperationProgress operation={STATE_FIXTURES.runningNoCount()} />),
    );
    expect(head()).toHaveTextContent('Adding the ticket template');
    expect(container.querySelector('[data-scene="busy"]')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('waiting: the reason, when it tries again, Close', () => {
    render(wrap(<OperationProgress operation={STATE_FIXTURES.waiting()} onClose={() => {}} />));
    expect(head()).toHaveTextContent('Waiting for Apple');
    expect(screen.getByText('Tries again in 6 h', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('stopping: Stop shows Stopping', () => {
    const op = { ...STATE_FIXTURES.running(), cancelRequested: true };
    render(wrap(<OperationProgress operation={op} onStop={() => {}} />));
    expect(screen.getByRole('button', { name: 'Stopping' })).toHaveAttribute('aria-busy', 'true');
  });

  it('succeeded: the done title, how long it took, the note, the next action; the erase waits By Dec 2', () => {
    const next = vi.fn();
    const { container } = render(
      wrap(
        <OperationProgress
          operation={STATE_FIXTURES.succeeded()}
          doneNote="Data is erased by Dec 2."
          next={{ label: 'Create sandbox', onClick: next }}
          onClose={() => {}}
        />,
      ),
    );
    expect(head()).toHaveTextContent('Sandbox deleted');
    expect(screen.getByText('Took 1:12')).toBeInTheDocument();
    expect(screen.getByText('Data is erased by Dec 2.')).toBeInTheDocument();
    expect(container.querySelector('[data-state="waiting"]')?.closest('li')).toHaveTextContent(
      'By Dec 2',
    );
    expect(screen.getByRole('button', { name: 'Create sandbox' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('failed: the failed step, its sentence, Retry first after the list, Details with the id', async () => {
    const onRetry = vi.fn();
    const op = STATE_FIXTURES.failed();
    const { container } = render(
      wrap(
        <OperationProgress
          operation={op}
          onRetry={onRetry}
          onClose={() => {}}
          zone="America/Los_Angeles"
        />,
      ),
    );
    expect(head()).toHaveTextContent('Could not finish your sandbox');
    const failed = container.querySelector('[data-state="failed"]')?.closest('li');
    expect(failed).toHaveTextContent('Add capture endpoint');
    expect(failed).toHaveTextContent('Webhooks are off on this plan. Retry.');
    expect(screen.getByText('Technical details')).toBeInTheDocument();
    expect(screen.getByText('OPERATION_FAILED')).toBeInTheDocument();
    expect(screen.getByText('2:13 PM')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.slice(-2)).toEqual(['Close', 'Retry']);
  });

  it('cancelled: Stopped, what was done, Close', () => {
    const { container } = render(
      wrap(<OperationProgress operation={STATE_FIXTURES.cancelled()} onClose={() => {}} />),
    );
    expect(head()).toHaveTextContent('Stopped');
    expect(container.querySelector('[data-state="skipped"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('groups a recreate and reads each wait in its own words', () => {
    const { container } = render(wrap(<OperationProgress operation={STATE_FIXTURES.recreate()} />));
    expect(screen.getByText('Old sandbox')).toBeInTheDocument();
    expect(screen.getByText('New sandbox')).toBeInTheDocument();
    expect(container.querySelector('[data-state="waiting"]')?.closest('li')).toHaveTextContent(
      'By Dec 2',
    );
  });

  it('has no axe violations in any state', async () => {
    for (const make of Object.values(STATE_FIXTURES)) {
      const { container, unmount } = render(
        wrap(<OperationProgress operation={make()} onClose={() => {}} />),
      );
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});

describe('the copy of every sandbox step', () => {
  const words = (def: typeof SANDBOX_CREATE) =>
    def.steps.map((s) => [s.label, 'active' in s ? s.active : undefined]);
  it('is exactly the design', () => {
    expect(words(SANDBOX_CREATE)).toEqual([
      ['Create sandbox', 'Creating your sandbox'],
      ['Add ticket template', 'Adding the ticket template'],
      ['Release it in Test', 'Releasing the ticket in Test'],
      ['Add capture endpoint', 'Adding the capture endpoint'],
      ['Add test scanner', 'Adding a test scanner'],
    ]);
    expect(words(SANDBOX_DELETE)).toEqual([
      ['Close sandbox', 'Closing your sandbox'],
      ['Revoke keys', 'Revoking keys'],
      ['Remove Test passes', 'Removing Test passes'],
      ['Erase sandbox data', undefined],
    ]);
    expect(words(SANDBOX_RESET)).toEqual([
      ['Revoke old key', 'Revoking the old key'],
      ['Delete Test passes', 'Deleting Test passes'],
      ['Delete captured events', 'Deleting captured events'],
      ['Clear calls and drafts', 'Clearing calls, messages and imports'],
      ['Release the ticket again', 'Releasing the ticket in Test'],
    ]);
    expect(SANDBOX_RECREATE.steps.map((s) => ('group' in s ? s.group : ''))).toEqual([
      ...Array(4).fill('Old sandbox'),
      ...Array(5).fill('New sandbox'),
    ]);
    expect(
      [SANDBOX_CREATE, SANDBOX_DELETE, SANDBOX_RESET, SANDBOX_RECREATE].map((d) => [
        d.title,
        d.doneTitle,
        d.failTitle,
      ]),
    ).toEqual([
      ['Create sandbox', 'Sandbox ready', 'Could not finish your sandbox'],
      ['Delete sandbox', 'Sandbox deleted', 'Could not delete sandbox'],
      ['Reset sandbox', 'Sandbox reset', 'Could not reset sandbox'],
      ['Start over', 'New sandbox ready', 'Could not start over'],
    ]);
  });

  it('reads each running step with its count: "Revoking keys · 1 of 2", "Deleting Test passes · 40 of 120"', () => {
    const at = (def: typeof SANDBOX_DELETE, key: string, done: number, total: number) =>
      fixtureOperation(def, { status: 'running', at: key, counts: { done, total } }).text;
    expect(at(SANDBOX_DELETE, 'keys', 1, 2)).toBe('Revoking keys · 1 of 2');
    expect(at(SANDBOX_RESET, 'passes', 40, 120)).toBe('Deleting Test passes · 40 of 120');
    expect(at(SANDBOX_RESET, 'rows', 3, 8)).toBe('Clearing calls, messages and imports · 3 of 8');
    expect(at(SANDBOX_RESET, 'captures', 12, 30)).toBe('Deleting captured events · 12 of 30');
  });
});

describe('the live region', () => {
  it('announces a step start and the end, never a count', () => {
    const at = (key: string, done: number) =>
      fixtureOperation(SANDBOX_DELETE, { status: 'running', at: key, counts: { done, total: 12 } });
    const { container, rerender } = render(wrap(<OperationProgress operation={at('passes', 4)} />));
    const region = live(container);
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Removing Test passes');
    expect(region.textContent).not.toMatch(/\d/);
    // Counts tick: the region is untouched.
    const mutations: string[] = [];
    const observer = new MutationObserver((m) => {
      for (const x of m) mutations.push(x.type);
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    for (const n of [5, 6, 7, 8])
      rerender(wrap(<OperationProgress operation={{ ...at('passes', n), revision: n }} />));
    expect(mutations).toEqual([]);
    expect(region).toHaveTextContent(/^Removing Test passes$/);
    // A new step: announced.
    rerender(wrap(<OperationProgress operation={at('erase', 0)} />));
    expect(region).toHaveTextContent('Erase sandbox data');
    // The end.
    rerender(wrap(<OperationProgress operation={STATE_FIXTURES.succeeded()} />));
    expect(region).toHaveTextContent('Sandbox deleted');
    rerender(wrap(<OperationProgress operation={STATE_FIXTURES.failed()} />));
    expect(region).toHaveTextContent(
      'Could not finish your sandbox. Webhooks are off on this plan. Retry.',
    );
    observer.disconnect();
  });

  it('is one region, mounted before its text changes', () => {
    const { container } = render(wrap(<OperationProgress operation={STATE_FIXTURES.running()} />));
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(announcement(STATE_FIXTURES.cancelled())).toBe('Stopped');
    expect(announcement(STATE_FIXTURES.waiting())).toBe('Waiting for Apple');
  });

  it('keeps counts out of the step list, which names its state in words', () => {
    const { container } = render(wrap(<OperationProgress operation={STATE_FIXTURES.running()} />));
    const list = container.querySelector('ol') as HTMLElement;
    expect(list).toHaveAttribute('aria-label', 'Delete sandbox');
    expect(list.querySelector('[aria-current="step"]')).toHaveTextContent('Remove Test passes');
    expect(within(list).getByText('4 of 12')).toBeInTheDocument();
  });
});

describe('focus', () => {
  it('moves to the next action when it succeeds while open; stays put on failure', () => {
    const next = { label: 'Show key', onClick: () => {} };
    const { rerender } = render(
      wrap(
        <OperationProgress operation={STATE_FIXTURES.running()} next={next} onClose={() => {}} />,
      ),
    );
    expect(document.body).toHaveFocus();
    rerender(
      wrap(
        <OperationProgress operation={STATE_FIXTURES.succeeded()} next={next} onClose={() => {}} />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Show key' })).toHaveFocus();
  });

  it('falls back to the title when there is no next action', () => {
    const { rerender } = render(wrap(<OperationProgress operation={STATE_FIXTURES.running()} />));
    rerender(wrap(<OperationProgress operation={STATE_FIXTURES.succeeded()} />));
    expect(head()).toHaveFocus();
  });

  it('leaves focus alone on a failure and does not steal it from a panel that opens done', () => {
    const { rerender } = render(
      wrap(<OperationProgress operation={STATE_FIXTURES.running()} onRetry={() => {}} />),
    );
    rerender(wrap(<OperationProgress operation={STATE_FIXTURES.failed()} onRetry={() => {}} />));
    expect(document.body).toHaveFocus();
    render(wrap(<OperationProgress operation={STATE_FIXTURES.succeeded()} onClose={() => {}} />));
    expect(document.body).toHaveFocus();
  });
});

describe('the local driver', () => {
  it('feeds the same panel from a browser-run flow', () => {
    const { operation } = (() => {
      let driver!: LocalOperation;
      function Flow() {
        const r = useLocalOperation(SANDBOX_DELETE);
        driver = r.driver;
        return <OperationProgress operation={r.operation} onClose={() => {}} />;
      }
      render(wrap(<Flow />));
      return { operation: driver };
    })();
    expect(head()).toHaveTextContent('Starting');
    act(() => operation.step('passes', { total: 12 }));
    act(() => operation.progress('passes', 4));
    expect(head()).toHaveTextContent('Removing Test passes · 4 of 12');
    act(() => operation.wait('erase', 'Waiting for the grace period', NOW + 3_600_000));
    expect(head()).toHaveTextContent('Waiting for the grace period');
    act(() => operation.fail('passes', 'Wallet did not answer. Retry.'));
    expect(screen.getAllByText('Wallet did not answer. Retry.').length).toBeGreaterThan(0);
    act(() => operation.retry());
    expect(operation.snapshot().attempt).toBe(2);
    act(() => operation.finish());
    expect(head()).toHaveTextContent('Sandbox deleted');
  });

  it('keeps revisions climbing and stops on request', () => {
    const d = new LocalOperation({ ...SANDBOX_DELETE, cancelable: true }, () => NOW);
    const before = d.snapshot().revision;
    d.step('close');
    d.requestStop();
    expect(d.stopping).toBe(true);
    d.stopped();
    expect(d.snapshot().status).toBe('cancelled');
    expect(d.snapshot().revision).toBeGreaterThan(before + 1);
  });
});

describe('a host that is not admin', () => {
  it('renders the panel with a bare apple-setup waiting step and no router, session or toaster', () => {
    const op = fixtureOperation(APPLE_SETUP, { status: 'waiting', at: 'issue' });
    render(<OperationProgress operation={op} framing="card" buddy={false} />);
    expect(head()).toHaveTextContent('Waiting for Apple');
  });
});
