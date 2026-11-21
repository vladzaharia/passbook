import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { ORG, templateDetail } from '../test-fixtures.ts';
import { leaveSelection } from './selection.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const preview = (over: Record<string, unknown> = {}) => ({
  targeted: 2,
  onDevice: 1,
  overBudget: 0,
  limit: 3,
  samples: [
    {
      passId: 'p1',
      title: 'Sam Lee',
      changes: [{ key: 'name', label: 'Member name', from: 'Al', to: 'Sam' }],
    },
  ],
  unchanged: 0,
  blocked: [],
  notified: 0,
  silent: 2,
  estimated: true,
  ...over,
});

const run = (id = 'r1') => ({
  id,
  orgId: 'org1',
  mode: 'live',
  kind: 'change',
  name: 'Change',
  state: 'sending',
  target: { templateIds: ['tpl1'] },
  patch: { name: { set: 'Sam' } },
  notify: false,
  at: null,
  clearAfter: null,
  parentId: null,
  ruleId: null,
  followUp: null,
  counts: { targeted: 2, updated: 0, unchanged: 0, overBudget: 0, failed: 0 },
  errorCode: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  leaveSelection('org1', { kind: 'ids', ids: ['p1', 'p2'], templateIds: ['tpl1'] });
});
afterEach(() => vi.unstubAllGlobals());

function setup(create: (body: Record<string, unknown>, key: string | null) => Response) {
  const previews: Record<string, unknown>[] = [];
  const result = renderApp('/admin/o/org1/passes/change', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/broadcasts/preview': (_u, init) => {
        previews.push(JSON.parse(String(init?.body)));
        return json(preview());
      },
      '/api/v1/broadcasts': (_u, init) =>
        create(JSON.parse(String(init?.body)), new Headers(init?.headers).get('idempotency-key')),
      '/api/v1/broadcasts/r1': () => json(run()),
    },
  });
  return { result, previews };
}

async function fillFirstStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add a field' }));
  await user.type(await screen.findByRole('textbox', { name: /Value/ }), 'Sam');
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('Change wizard', () => {
  it('runs silent by default, with the count the person saw and one idempotency key', async () => {
    const sent: { body: Record<string, unknown>; key: string | null }[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      return json(run(), 201);
    });
    const user = userEvent.setup();
    await fillFirstStep(user);
    expect(await screen.findByRole('switch', { name: 'Notify holders' })).not.toBeChecked();
    expect(screen.getByText(/Passes update quietly/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({
      kind: 'change',
      notify: false,
      send: 'now',
      patch: { name: { set: 'Sam' } },
      target: { passIds: ['p1', 'p2'], expectCount: 2 },
    });
    expect(sent[0]?.key).toBeTruthy();
    expect(await screen.findByText('0 of 2'.replace('0', '0'))).toBeInTheDocument();
  });

  it('says who is told is an estimate from the 200 newest', async () => {
    setup(() => json(run(), 201));
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('switch', { name: 'Notify holders' }));
    expect(await screen.findByText('Estimated from the 200 newest passes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Write the message or turn Notify off.')).toBeInTheDocument();
  });

  it('shows the new count when the selection changed, and runs on it after a confirm', async () => {
    const counts: unknown[] = [];
    setup((body) => {
      const target = body.target as { expectCount: number };
      counts.push(target.expectCount);
      return counts.length === 1
        ? problem(409, 'SELECTION_CHANGED', 'The selection changed.')
        : json(run(), 201);
    });
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    expect(await screen.findByText(/It now matches 2 passes/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(counts).toHaveLength(2));
  });

  it('words a refused call in one line', async () => {
    setup(() => problem(403, 'KEY_TEST_ONLY', 'x'));
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    expect(
      await screen.findByText('Only a Test key can do this. Use a person for Live.'),
    ).toBeInTheDocument();
  });
});
