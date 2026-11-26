import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json } from '../../../lib/test-utils.tsx';
import { candidate, mountPanel, release, releaseServer, TEMPLATE } from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

const STRIP = 'image.strip@strip';
const PLACES = 'relevance.locations@locations';

const omitted = (
  capability: 'image.strip' | 'relevance.locations',
  path: string,
  message: string,
) =>
  ({
    capability,
    path,
    support: 'omitted',
    severity: 'omission',
    group: 'holder',
    chosen: false,
    message,
  }) as const;
const ITEMS = [
  omitted('image.strip', 'strip', 'The strip image is not shown.'),
  omitted('relevance.locations', 'locations', 'Lock screen places are not used.'),
];

function report(
  status: FidelityReportDto['status'],
  items: FidelityReportDto['items'] = [],
): FidelityReportDto {
  return { schema: 1, target: 'google', type: 'generic', compilerRevision: 1, status, items };
}
const READY = report({ kind: 'ready' });
const TWO = report({ kind: 'omissions', count: 2 }, ITEMS);
const ONE_OLD = report({ kind: 'omissions', count: 1 }, ITEMS.slice(0, 1));

const enrolment = {
  mode: 'live',
  provider: 'google',
  accountId: null,
  source: null,
  platformAvailable: true,
  state: 'on',
  enrolmentRevision: 0,
  prerequisites: { check: false, roundTrip: null },
  hold: null,
  issuance: { state: 'enabled' },
};

/** The release server, with Google's candidate list carrying the report the server compiled. */
function serve(options: {
  current: FidelityReportDto | null;
  active?: ReturnType<typeof release> | null;
  candidates?: ReturnType<typeof candidate>[];
}) {
  const server = releaseServer({
    active: options.active ?? null,
    candidates: options.candidates ?? [],
  });
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/orgs/org-1/wallet-enrolments')
      return Promise.resolve(json({ items: [enrolment], nextCursor: null }));
    if (
      url.pathname === `/api/v1/templates/${TEMPLATE}/candidates` &&
      url.searchParams.get('provider') === 'google' &&
      (init?.method ?? 'GET') === 'GET'
    )
      return Promise.resolve(
        json({
          items: server.candidates,
          nextCursor: null,
          ...(options.current
            ? {
                current: {
                  version: 'version-2',
                  sourceReleaseId: 'release-apple',
                  report: options.current,
                },
              }
            : {}),
        }),
      );
    return inner(input, init);
  });
  return server;
}

const googleRow = async () => {
  const list = await screen.findByRole('list', { name: 'Wallets' });
  const row = within(list).getByText('Google Wallet').closest('li');
  if (!row) throw new Error('Google row missing');
  await waitFor(() => expect(row).not.toHaveTextContent('Loading release'));
  return row;
};

describe('wallet release review', () => {
  it('reads Ready when the report has nothing to approve', async () => {
    serve({ current: READY });
    const { container } = mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Ready');
    expect(row).not.toHaveTextContent('omissions');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reads Ready with omissions (n)', async () => {
    serve({ current: TWO });
    mountPanel();
    expect(await googleRow()).toHaveTextContent('Ready with omissions (2)');
  });

  it('reads Blocked with the reason and shows it in the review', async () => {
    serve({ current: report({ kind: 'blocked', reason: 'barcode.format is required.' }) });
    mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Blocked');
    expect(row).toHaveTextContent('barcode.format is required.');
    await userEvent.click(within(row).getByRole('button', { name: 'Review Google Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Google Wallet' });
    expect(within(dialog).getByText('barcode.format is required.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('reads Review needed: new omission after a pipeline change, naming the item', async () => {
    const pinned = candidate({
      id: 'candidate-g',
      provider: 'google',
      version: 'version-2',
      projection: { schema: 2, provider: 'google', approvedOmissions: [STRIP] },
    });
    serve({
      current: TWO,
      active: release({
        provider: 'google',
        version: 'version-2',
        candidateId: 'candidate-g',
        approvalId: 'approval-g',
      }),
      candidates: [pinned],
    });
    mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Review needed: new omission');
    expect(row).toHaveTextContent('Lock screen places are not used.');
    expect(row).not.toHaveTextContent('The strip image');
    await userEvent.click(within(row).getByRole('button', { name: 'Review Google Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Google Wallet' });
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).not.toBeChecked();
    expect(within(dialog).getByText('New')).toBeInTheDocument();
    expect(within(dialog).getByText(`relevance.locations · locations`)).toBeInTheDocument();
  });

  it('reads Review needed: new omission when a template change adds one to an older release', async () => {
    // The passes move to the newest Apple release, which has no approved projection yet: offers wait.
    const pinned = candidate({
      id: 'candidate-g',
      provider: 'google',
      version: 'version-1',
      projection: { schema: 2, provider: 'google', approvedOmissions: [STRIP] },
    });
    serve({
      current: TWO,
      active: release({
        provider: 'google',
        version: 'version-1',
        candidateId: 'candidate-g',
        approvalId: 'approval-g',
      }),
      candidates: [pinned],
    });
    mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Review needed: new omission');
    expect(row).toHaveTextContent('Lock screen places are not used.');
  });

  it('reads Review needed: new type when the compiled type moved off the approved one', async () => {
    // Q21 pauses offers for a changed type as it does for a new omission: the row cannot read Released.
    const pinned = candidate({
      id: 'candidate-g',
      provider: 'google',
      version: 'version-2',
      projection: { schema: 2, provider: 'google', type: 'loyalty', approvedOmissions: [] },
    });
    serve({
      current: READY,
      active: release({
        provider: 'google',
        version: 'version-2',
        candidateId: 'candidate-g',
        approvalId: 'approval-g',
      }),
      candidates: [pinned],
    });
    mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Review needed: new type');
    expect(row).toHaveTextContent('Now generic, approved as loyalty.');
    expect(row).not.toHaveTextContent('Released');
  });

  it('reads Released when the approval covers every omission', async () => {
    serve({
      current: ONE_OLD,
      active: release({ provider: 'google', version: 'version-2', candidateId: 'candidate-g' }),
      candidates: [
        candidate({
          id: 'candidate-g',
          provider: 'google',
          projection: { schema: 2, provider: 'google', approvedOmissions: [STRIP] },
        }),
      ],
    });
    mountPanel();
    const row = await googleRow();
    expect(row).toHaveTextContent('Released');
    expect(row).toHaveTextContent('Ready with omissions (1)');
  });

  it('approves item by item, then requests, approves and releases', async () => {
    const user = userEvent.setup();
    const server = serve({ current: TWO });
    mountPanel();
    const row = await googleRow();
    await user.click(within(row).getByRole('button', { name: 'Review Google Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Google Wallet' });
    const approve = within(dialog).getByRole('button', { name: 'Approve and release' });
    expect(approve).toBeDisabled();
    const [first, second] = within(dialog).getAllByRole('checkbox');
    if (!first || !second) throw new Error('Omission checkboxes missing');
    await user.click(first);
    expect(approve).toBeDisabled();
    await user.click(second);
    expect(approve).toBeEnabled();
    await user.click(approve);
    await waitFor(() =>
      expect(server.requests.filter((r) => r.method === 'POST').map((r) => r.url.pathname)).toEqual(
        [
          `/api/v1/templates/${TEMPLATE}/candidates`,
          `/api/v1/templates/${TEMPLATE}/candidates/candidate-1/approve`,
          `/api/v1/templates/${TEMPLATE}/releases`,
        ],
      ),
    );
    const posts = server.requests.filter((r) => r.method === 'POST');
    expect(posts[0]?.body).toMatchObject({
      provider: 'google',
      version: 'version-2',
      sourceReleaseId: 'release-apple',
      projection: { schema: 2, provider: 'google', approvedOmissions: [PLACES, STRIP].sort() },
    });
    expect(posts[1]?.body).not.toHaveProperty('alone');
  });

  it('sends alone only when the release state says the caller is alone', async () => {
    const user = userEvent.setup();
    const server = serve({ current: TWO });
    mountPanel({
      release: {
        live: null,
        test: null,
        draft: null,
        review: { state: 'none' },
        alone: true,
        next: null,
      },
    });
    const row = await googleRow();
    await user.click(within(row).getByRole('button', { name: 'Review Google Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Google Wallet' });
    expect(within(dialog).getByText(/only reviewer/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Check all' }));
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(server.requests.some((r) => r.url.pathname.endsWith('/approve'))).toBe(true),
    );
    const approval = server.requests.find((r) => r.url.pathname.endsWith('/approve'));
    expect(approval?.body.alone).toBe(true);
  });

  it('shows the buddy and nothing to approve when nothing is left out', async () => {
    const user = userEvent.setup();
    serve({ current: READY });
    mountPanel();
    const row = await googleRow();
    await user.click(within(row).getByRole('button', { name: 'Review Google Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Google Wallet' });
    expect(within(dialog).getByText('Nothing is left out')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve and release' })).toBeEnabled();
  });
});
