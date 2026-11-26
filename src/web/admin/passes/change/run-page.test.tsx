import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { broadcast } from '../../messages/test-fixtures.ts';
import { ORG } from '../test-fixtures.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

const change = (over: Parameters<typeof broadcast>[0] = {}) =>
  broadcast({
    id: 'r1',
    orgId: 'org1',
    kind: 'change',
    patch: { plan: { set: 'annual' } },
    notify: false,
    ...over,
  });

function setup(
  run: ReturnType<typeof change>,
  extra: Record<string, () => Response> = {},
  follow: { parentId?: ReturnType<typeof change>; retryOf?: ReturnType<typeof change> } = {},
) {
  return renderApp('/admin/o/org1/passes/change/r1', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/broadcasts/r1': () => json(run),
      // The undo run (parentId) and the resume (retryOf) are looked up by filter.
      '/api/v1/broadcasts': (url) => {
        const hit = url.searchParams.has('parentId') ? follow.parentId : follow.retryOf;
        return json({ items: hit ? [hit] : [], nextCursor: null });
      },
      ...extra,
    },
  });
}

describe('Change run page', () => {
  it('names a plain message as a missing change run, without a state chip', async () => {
    setup(change({ kind: 'message', state: 'scheduled', at: Date.now() + 86_400_000 }));
    expect(await screen.findByText('Change run not found')).toBeInTheDocument();
    expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to passes' })).toBeInTheDocument();
  });

  it('shows progress with Stop while it runs', async () => {
    setup(
      change({
        state: 'sending',
        counts: { targeted: 10, updated: 3, unchanged: 1, overBudget: 0, failed: 0 },
      }),
    );
    expect(await screen.findByText('4 of 10')).toBeInTheDocument();
    expect(screen.getByText('You can leave this page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('offers a silent undo until 24 hours after it finished, and asks first', async () => {
    const asked: string[] = [];
    setup(change(), {
      '/api/v1/broadcasts/r1/undo': () => {
        asked.push('undo');
        return json({ id: 'u1', parentId: 'r1', restorable: 2, kept: 0 });
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText(/Restores silently/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo change' }));
    await screen.findByText('Undo this change?');
    await user.click(screen.getAllByRole('button', { name: 'Undo change' }).at(-1) as HTMLElement);
    await waitFor(() => expect(asked).toEqual(['undo']));
  });

  it('does not offer an undo for a move to the latest design', async () => {
    setup(change({ patch: { $design: true } }));
    expect(await screen.findByText(/can’t be undone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo change' })).not.toBeInTheDocument();
  });

  it('resumes a stopped run on the passes it has left, and words a refusal', async () => {
    setup(
      change({
        state: 'cancelled',
        errorCode: 'BROADCAST_STOPPED',
        counts: { targeted: 5, updated: 2, unchanged: 0, overBudget: 0, failed: 0 },
      }),
      { '/api/v1/broadcasts/r1/retry': () => problem(409, 'BROADCAST_NOT_RETRYABLE', 'x') },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Resume 3 passes' }));
    expect(
      await screen.findByText('This run can’t be resumed. Start a new change.'),
    ).toBeInTheDocument();
  });

  it('says the undo window has passed', async () => {
    setup(change({ finishedAt: Date.now() - 25 * 3_600_000 }));
    expect(await screen.findByText('The undo window has passed.')).toBeInTheDocument();
  });

  it('reads a run booked for now as starting, not scheduled', async () => {
    setup(change({ state: 'scheduled', at: Date.now() + 5_000, finishedAt: null }));
    expect((await screen.findAllByText('Starting')).length).toBe(2);
    expect(screen.queryByText(/^Starts /)).not.toBeInTheDocument();
  });

  it('cancels a change booked for later, after a confirm', async () => {
    const cancelled: string[] = [];
    setup(change({ state: 'scheduled', at: Date.now() + 86_400_000, finishedAt: null }), {
      '/api/v1/broadcasts/r1/cancel': () => {
        cancelled.push('r1');
        return json(change({ state: 'cancelled' }));
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText(/^Starts /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to passes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel change' }));
    await waitFor(() => expect(cancelled).toEqual(['r1']));
  });

  it('says why a failed run stopped', async () => {
    setup(
      change({
        state: 'failed',
        errorCode: 'MATCH_TOO_BROAD',
        counts: { targeted: 0, updated: 0, unchanged: 0, overBudget: 0, failed: 0 },
      }),
    );
    expect(
      await screen.findByText('More than 20,000 passes match. Narrow the filter.'),
    ).toBeInTheDocument();
  });

  it('shows the undo as progress while it runs, then what it kept', async () => {
    const undoRun = change({
      id: 'u1',
      parentId: 'r1',
      state: 'sending',
      counts: { targeted: 10, updated: 3, unchanged: 0, overBudget: 0, failed: 0 },
    });
    setup(change(), {}, { parentId: undoRun });
    expect(await screen.findByText('Undoing: 3 of 10')).toBeInTheDocument();
  });

  it('words an undo that stopped, and does not call the change undone', async () => {
    const undoRun = change({
      id: 'u1',
      parentId: 'r1',
      state: 'failed',
      counts: { targeted: 2, updated: 1, unchanged: 0, overBudget: 0, failed: 1 },
    });
    setup(change(), {}, { parentId: undoRun });
    expect(await screen.findByText('The undo stopped. Restored 1.')).toBeInTheDocument();
    expect(screen.queryByText('Change undone')).not.toBeInTheDocument();
  });

  it('shows the undo result in place of the change counters once undone', async () => {
    const undoRun = change({
      id: 'u1',
      parentId: 'r1',
      state: 'sent',
      counts: { targeted: 2, updated: 2, unchanged: 0, overBudget: 0, failed: 0 },
    });
    setup(change(), {}, { parentId: undoRun });
    expect(await screen.findByText('Restored 2.')).toBeInTheDocument();
    expect(screen.queryByText('Changed')).not.toBeInTheDocument();
    expect(screen.queryByText('Already set')).not.toBeInTheDocument();
  });

  it('links to the run that resumed this one instead of offering Resume again', async () => {
    const child = change({ id: 'r2', state: 'sending' });
    setup(
      change({
        state: 'cancelled',
        errorCode: 'BROADCAST_STOPPED',
        counts: { targeted: 5, updated: 2, unchanged: 0, overBudget: 0, failed: 0 },
      }),
      {},
      { retryOf: child },
    );
    expect(await screen.findByRole('link', { name: 'Open the resumed run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resume/ })).not.toBeInTheDocument();
  });
});
