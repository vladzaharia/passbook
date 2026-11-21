import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setCsrfProvider } from '../../lib/api.ts';
import { resetModeForTests } from '../../lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail } from '../passes/test-fixtures.ts';

beforeEach(() => setCsrfProvider(async () => 'csrf'));
afterEach(() => {
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

const LIVE = 'a1b2c3d4e5f6a7b8';
const DRAFT = 'ffeeddccbbaa9988';
const state = (over: Record<string, unknown> = {}) => ({
  live: { version: LIVE, at: 1_700_000_000_000, by: 'Alex Kim' },
  test: { version: LIVE, at: 1_700_000_000_000, state: 'following' },
  draft: { version: DRAFT, at: 1_700_000_100_000 },
  review: { state: 'open', version: DRAFT, by: 'Alex Kim', at: 1_700_000_100_000 },
  alone: false,
  next: 'review',
  ...over,
});
const detail = (release: unknown) => {
  const d = templateDetail({ release });
  d.versions[1] = { ...d.versions[1], report: { ok: true, issues: [] } } as (typeof d.versions)[1];
  return d;
};
const mode = {
  outcome: 'review_required',
  from: LIVE,
  expectedGeneration: 1,
  candidate: { action: 'reuse', id: 'c1' },
  approval: { action: 'needed', kind: null },
  impact: { passes: { count: 12, capped: false }, devices: { count: 9, capped: false } },
};
const plan = () =>
  json({
    version: DRAFT,
    modes: { test: mode, live: mode },
    diff: [
      {
        group: 'colors',
        rows: [
          {
            label: 'Background',
            kind: 'changed',
            from: { type: 'color', color: '#0F766E' },
            to: { type: 'color', color: '#4338CA' },
          },
        ],
        more: 0,
      },
    ],
    fromVersion: LIVE,
    state: state(),
  });
const _done = { outcome: 'released', releaseId: 'r1', generation: 2, approvalKind: 'peer' };

function open(caps: string[], review: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    render: () =>
      renderApp('/admin/templates/tpl1', {
        session: 'admin',
        memberships: [membershipFixture(ORG.id, { capabilities: caps as never })],
        selectedOrg: ORG.id,
        handlers: {
          '/api/v1/templates/tpl1': () => json(detail(state())),
          '/api/v1/templates/previews': previewsHandler,
          '/api/v1/template-reviews': () => json({ items: [], nextCursor: null }),
          '/api/v1/templates/tpl1/release': plan,
          '/api/v1/templates/tpl1/review': (_url, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            bodies.push(body);
            return review(body);
          },
        },
      }),
  };
}

it('shows the draft as in review and opens the review from the primary', async () => {
  const t = open(['templates:read', 'templates:review'], () => json({}));
  await t.render();
  const strip = await screen.findByRole('region', { name: 'Release' });
  expect(strip).toHaveTextContent('In review · Alex Kim');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Review v2' }));
  const dialog = await screen.findByRole('dialog', { name: 'Review v2' });
  expect(await within(dialog).findByText('#4338CA')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('From Alex Kim');
  expect(dialog).toHaveTextContent('12 passes update');
  expect(within(dialog).queryByRole('button', { name: 'Approve and release' })).toBeNull();
});

it('approves and releases in one call when the reviewer can publish', async () => {
  const t = open(['templates:read', 'templates:review', 'templates:publish'], () =>
    json({
      version: DRAFT,
      approved: ['test', 'live'],
      release: { version: DRAFT, modes: {}, state: state() },
    }),
  );
  await t.render();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Review v2' }));
  const dialog = await screen.findByRole('dialog', { name: 'Review v2' });
  await user.click(await within(dialog).findByRole('button', { name: 'Approve and release' }));
  await waitFor(() => expect(t.bodies).toHaveLength(1));
  expect(t.bodies[0]).toEqual({ orgId: ORG.id, version: DRAFT, release: true });
});

it('says so when the request is no longer open, and offers no approval', async () => {
  const t = open(['templates:read', 'templates:review'], () =>
    problem(
      404,
      'TEMPLATE_REVIEW_NOT_FOUND',
      'No review was requested for this version. Ask the author to request one.',
    ),
  );
  await t.render();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Review v2' }));
  const dialog = await screen.findByRole('dialog', { name: 'Review v2' });
  await user.click(await within(dialog).findByRole('button', { name: 'Approve' }));
  expect(await within(dialog).findByText(/No review was requested/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeDisabled();
});

it('lists open requests on Templates and counts them in the nav', async () => {
  await renderApp('/admin/templates', {
    session: 'admin',
    memberships: [
      membershipFixture(ORG.id, { capabilities: ['templates:read', 'templates:review'] }),
    ],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      '/api/v1/template-reviews': () =>
        json({
          items: [
            {
              templateId: 'tpl1',
              templateName: 'Gym membership',
              orgId: ORG.id,
              version: DRAFT,
              requestedBy: 'Alex Kim',
              requestedAt: Date.now() - 3_600_000,
            },
          ],
          nextCursor: null,
        }),
    },
  });
  const inbox = await screen.findByRole('region', { name: /Needs your review/ });
  expect(inbox).toHaveTextContent('Gym membership');
  expect(inbox).toHaveTextContent('Alex Kim');
  expect(await screen.findAllByRole('status', { name: '1 to review' })).not.toHaveLength(0);
});
