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

function setup(run: ReturnType<typeof change>, extra: Record<string, () => Response> = {}) {
  return renderApp('/admin/o/org1/passes/change/r1', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/broadcasts/r1': () => json(run),
      '/api/v1/broadcasts': () => json({ items: [run], nextCursor: null }),
      ...extra,
    },
  });
}

describe('Change run page', () => {
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
      (await screen.findAllByText('This run can’t be resumed. Start a new change.')).length,
    ).toBeGreaterThan(0);
  });

  it('says the undo window has passed', async () => {
    setup(change({ finishedAt: Date.now() - 25 * 3_600_000 }));
    expect(await screen.findByText('The undo window has passed.')).toBeInTheDocument();
  });
});
