import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { importDto } from '../import/import-test-fixtures.ts';
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

interface Sent {
  body: Record<string, unknown>;
  key: string | null;
}

function setup(
  create: (body: Record<string, unknown>, key: string | null) => Response,
  options: { path?: string; previews?: (n: number) => Record<string, unknown> } = {},
) {
  const previews: Record<string, unknown>[] = [];
  const result = renderApp(options.path ?? '/admin/o/org1/passes/change', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/pass-imports/imp1': () =>
        json(
          importDto({
            id: 'imp1',
            templateId: 'tpl1',
            counts: {
              rows: 1240,
              create: 1200,
              update: 40,
              unchanged: 0,
              errors: 0,
              warnings: 0,
              emailable: 0,
            },
          }),
        ),
      '/api/v1/broadcasts/preview': (_u, init) => {
        previews.push(JSON.parse(String(init?.body)));
        return json(preview(options.previews?.(previews.length) ?? {}));
      },
      '/api/v1/broadcasts': (_u, init) =>
        create(JSON.parse(String(init?.body)), new Headers(init?.headers).get('idempotency-key')),
      '/api/v1/broadcasts/r1': () => json(run()),
    },
  });
  return { result, previews };
}

const next = () => screen.getByRole('button', { name: /^Next$/ });

async function fillFirstStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add a field' }));
  await user.type(await screen.findByRole('textbox', { name: /Value/ }), 'Sam');
  await user.click(next());
}

/** Through Tell holders to Review, with the run button ready. */
async function toReview(user: ReturnType<typeof userEvent.setup>, label = 'Change 2 passes') {
  await fillFirstStep(user);
  await user.click(await screen.findByRole('button', { name: /^Next$/ }));
  return screen.findByRole('button', { name: label });
}

describe('Change wizard', () => {
  it('runs silent by default, with the count the person saw', async () => {
    const sent: Sent[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      return json(run(), 201);
    });
    const user = userEvent.setup();
    await fillFirstStep(user);
    expect(await screen.findByRole('switch', { name: 'Notify holders' })).not.toBeChecked();
    expect(screen.getByText(/Passes update quietly/)).toBeInTheDocument();
    await user.click(next());
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
    expect(await screen.findByText('0 of 2')).toBeInTheDocument();
  });

  it('keeps one idempotency key when a failed send is tried again', async () => {
    const sent: Sent[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      return sent.length === 1 ? problem(500, 'INTERNAL', 'x') : json(run(), 201);
    });
    const user = userEvent.setup();
    await user.click(await toReview(user));
    await waitFor(() => expect(sent).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.key).toBe(sent[0]?.key);
  });

  it('shows a rate-limited create as the error card with its wait, keeps the selection, and retries the same call', async () => {
    const sent: Sent[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      if (sent.length > 1) return json(run(), 201);
      const res = problem(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
      res.headers.set('retry-after', '120');
      return res;
    });
    const user = userEvent.setup();
    await user.click(await toReview(user));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Try again in 2 minutes.');
    // The wizard is out of the way, not gone: Back to review shows the same step and selection.
    await user.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(await screen.findByRole('button', { name: 'Change 2 passes' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await user.click(screen.getByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  });

  it('retries a rate-limited create from the error card', async () => {
    const sent: Sent[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      return sent.length > 1 ? json(run(), 201) : problem(429, 'RATE_LIMITED', 'x');
    });
    const user = userEvent.setup();
    await user.click(await toReview(user));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a minute.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.key).toBe(sent[0]?.key);
  });

  it('says who is told is an estimate from the 200 newest, and asks for the text after Next', async () => {
    setup(() => json(run(), 201), {
      previews: () => ({ targeted: 500, notified: 300, silent: 200 }),
    });
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('switch', { name: 'Notify holders' }));
    expect(await screen.findByText('Estimated from the 200 newest passes.')).toBeInTheDocument();
    // Next says why it is off; the field's own error waits for the press.
    expect(screen.getAllByText('Write the message or turn Notify off.')).toHaveLength(1);
    await user.click(next());
    expect(screen.getAllByText('Write the message or turn Notify off.')).toHaveLength(2);
  });

  it('shows the new count when the selection moved and sends it after a confirm', async () => {
    const counts: unknown[] = [];
    setup(
      (body) => {
        counts.push((body.target as { expectCount: number }).expectCount);
        return counts.length === 1
          ? problem(409, 'SELECTION_CHANGED', 'The selection changed.')
          : json(run(), 201);
      },
      { previews: (n) => (n > 1 ? { targeted: 3 } : {}) },
    );
    const user = userEvent.setup();
    await user.click(await toReview(user));
    expect(await screen.findByText(/It now matches 3 passes/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(counts).toEqual([2, 3]));
  });

  it('words a refused call in one line', async () => {
    setup(() => problem(403, 'KEY_TEST_ONLY', 'x'));
    const user = userEvent.setup();
    await user.click(await toReview(user));
    expect(
      await screen.findByText('Only a Test key can do this. Use a person for Live.'),
    ).toBeInTheDocument();
  });

  it('lets a run go on the server count when the 200-pass estimate says nothing changes', async () => {
    setup(() => json(run(), 201), {
      previews: () => ({ targeted: 1500, unchanged: 1500, silent: 0 }),
    });
    const user = userEvent.setup();
    const run_ = await toReview(user, 'Change 1,500 passes');
    expect(run_).not.toHaveAttribute('aria-disabled');
    expect(
      screen.getByText('Counts are estimated from the 200 newest passes.'),
    ).toBeInTheDocument();
  });

  it('turns Run off when an exact preview says nothing would change', async () => {
    setup(() => json(run(), 201), { previews: () => ({ unchanged: 2, silent: 0 }) });
    const user = userEvent.setup();
    const button = await toReview(user);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('Nothing would change.').length).toBeGreaterThan(0);
  });

  it('turns Run off only when the server counts no passes', async () => {
    setup(() => json(run(), 201), { previews: () => ({ targeted: 0, samples: [] }) });
    const user = userEvent.setup();
    await toReview(user, 'Change 0 passes').then((b) =>
      expect(b).toHaveAttribute('aria-disabled', 'true'),
    );
  });

  it('voids behind a confirm, on a danger button that reads Void N passes', async () => {
    const sent: Sent[] = [];
    setup((body, key) => {
      sent.push({ body, key });
      return json(run(), 201);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /^Void/ }));
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'Void 2 passes' }));
    expect(sent).toHaveLength(0);
    const ask = await screen.findByRole('alertdialog', { name: 'Void 2 passes?' });
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ patch: { $void: true }, send: 'now' });
  });

  it('asks Tell holders for a start time before going on, and shows it on Review', async () => {
    setup(() => json(run(), 201));
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('radio', { name: 'Later' }));
    expect(next()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Pick a start time.')).toBeInTheDocument();
  });
});

describe('Change wizard selections', () => {
  const sendTo = async (sent: Sent[]) => {
    const user = userEvent.setup();
    await fillFirstStep(user);
    await user.click(await screen.findByRole('button', { name: /^Next$/ }));
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    return sent[0]?.body.target;
  };
  const collect = () => {
    const sent: Sent[] = [];
    return {
      sent,
      create: (body: Record<string, unknown>, key: string | null) => {
        sent.push({ body, key });
        return json(run(), 201);
      },
    };
  };

  it('runs a Select all matching filter with the template, the filters and the reviewed count', async () => {
    leaveSelection('org1', {
      kind: 'filter',
      filter: { templateId: 'tpl1', q: 'ann' },
      count: 2,
      templateIds: ['tpl1'],
    });
    const c = collect();
    setup(c.create);
    expect(await sendTo(c.sent)).toEqual({ templateIds: ['tpl1'], q: 'ann', expectCount: 2 });
  });

  it('keeps the list filters on an import, so a chip never widens to the whole import', async () => {
    leaveSelection('org1', {
      kind: 'filter',
      filter: { importId: 'imp1', q: 'ann', onDevice: true },
      count: 2,
      templateIds: ['tpl1'],
    });
    const c = collect();
    setup(c.create);
    expect(await sendTo(c.sent)).toEqual({
      importId: 'imp1',
      q: 'ann',
      onDevice: true,
      expectCount: 2,
    });
  });

  it('confirms the new count only when it went up', async () => {
    leaveSelection('org1', {
      kind: 'filter',
      filter: { templateId: 'tpl1' },
      count: 1,
      templateIds: ['tpl1'],
    });
    const c = collect();
    setup(c.create);
    const user = userEvent.setup();
    await user.click(await toReview(user));
    expect(await screen.findByText(/It now matches 2 passes/)).toBeInTheDocument();
    expect(c.sent).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(c.sent).toHaveLength(1));
  });

  it('says N of M can change, without a confirm, when fewer passes can be reached', async () => {
    leaveSelection('org1', {
      kind: 'filter',
      filter: { templateId: 'tpl1' },
      count: 5,
      templateIds: ['tpl1'],
    });
    const c = collect();
    setup(c.create);
    const user = userEvent.setup();
    await toReview(user);
    expect(await screen.findByText('2 of the 5 selected can change.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(c.sent).toHaveLength(1));
    expect(screen.queryByText(/It now matches/)).not.toBeInTheDocument();
  });

  it('forgets the hand-off once a run is made, so a plain visit opens empty', async () => {
    const c = collect();
    setup(c.create);
    const user = userEvent.setup();
    await user.click(await toReview(user));
    await waitFor(() => expect(c.sent).toHaveLength(1));
    expect(sessionStorage.getItem('passbook.change-selection')).toBeNull();
  });

  it('refuses a stored filter a run cannot take, never falling back to the template', async () => {
    leaveSelection('org1', {
      kind: 'filter',
      filter: { templateId: 'tpl1', connectionId: 'c1' },
      count: 5,
      templateIds: ['tpl1'],
    });
    const c = collect();
    setup(c.create);
    expect(await screen.findByText('Pick passes to change first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a field' })).not.toBeInTheDocument();
  });

  it('opens Change these on the import, not on a selection left in the tab', async () => {
    const c = collect();
    setup(c.create, { path: '/admin/o/org1/passes/change?importId=imp1' });
    expect(await sendTo(c.sent)).toEqual({ importId: 'imp1', expectCount: 2 });
  });

  it('says how many passes the import made or changed on the first step', async () => {
    const c = collect();
    setup(c.create, { path: '/admin/o/org1/passes/change?importId=imp1' });
    expect(await screen.findByText('1,240 passes of this import')).toBeInTheDocument();
  });

  it('opens Tell holders on the template with Notify on', async () => {
    const c = collect();
    setup(c.create, {
      path: '/admin/o/org1/passes/change?templateId=tpl1&kind=design&tell=true',
    });
    expect(await screen.findByText('All active passes of Copper card')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(next());
    expect(await screen.findByRole('switch', { name: 'Notify holders' })).toBeChecked();
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'Change 2 passes' }));
    await waitFor(() => expect(c.sent).toHaveLength(1));
    expect(c.sent[0]?.body).toMatchObject({
      notify: true,
      patch: { $design: true },
      target: { templateIds: ['tpl1'], expectCount: 2 },
    });
  });
});
