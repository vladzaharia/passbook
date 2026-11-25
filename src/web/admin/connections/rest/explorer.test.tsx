import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import { CONNECTOR, connectionDetail, ORG } from '../../passes/test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const lbl = (k: string) => ({ type: 'string', 'x-label': k });
const REST = {
  ...CONNECTOR,
  version: 2,
  configSchema: {
    type: 'object',
    required: ['baseUrl'],
    properties: {
      baseUrl: { type: 'string', format: 'uri', 'x-label': 'Base URL' },
      holderEmailPointer: lbl('Holder email'),
      list: {
        type: 'object',
        'x-label': 'List endpoint',
        required: ['path'],
        properties: {
          path: lbl('List path'),
          recordsPointer: lbl('Records'),
          idPointer: lbl('Record ID'),
          query: { type: 'array', items: { type: 'object', properties: { name: lbl('n') } } },
          pagination: { anyOf: [{ type: 'object' }, { type: 'object' }] },
          incremental: { type: 'object', properties: { param: lbl('p') } },
        },
      },
    },
  },
};
const stored = { baseUrl: 'https://api.example.com/v1', list: { path: '/members' } };

const BODY = {
  data: [
    { id: 'm_1', email: 'a@x.com', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'm_2', email: 'b@x.com', updated_at: '2026-01-02T00:00:00Z' },
  ],
  meta: { next_cursor: 'abc', total: 4 },
};
const field = (pointer: string, label: string, type = 'text') => ({
  pointer,
  jsonPath: `$.data[*]${pointer.replace('/', '.')}`,
  label,
  type,
  samples: ['x'],
});
const DETECT = {
  records: [{ pointer: '/data', jsonPath: '$.data[*]', count: 2, score: 0.9, reason: 'name' }],
  pagination: [
    {
      confidence: 'high',
      config: {
        style: 'cursor',
        param: 'cursor',
        cursorPointer: '/meta/next_cursor',
        from: 'body',
      },
      evidence: 'field:/meta/next_cursor',
    },
  ],
  id: [{ pointer: '/id', jsonPath: '$.data[*].id', unique: true, score: 0.95 }],
  updatedAt: [
    { pointer: '/updated_at', jsonPath: '$.data[*].updated_at', format: 'iso', score: 0.9 },
  ],
  holderEmail: [{ pointer: '/email', jsonPath: '$.data[*].email' }],
  fields: [field('/id', 'id'), field('/email', 'email', 'email')],
  rateLimit: null,
};
const REQUEST = {
  method: 'GET',
  url: 'https://api.example.com/v1/members',
  status: 200,
  bytes: 48_000,
  contentType: 'application/json',
};
const ok = (over: Record<string, unknown> = {}) => ({
  ok: true,
  durationMs: 312,
  request: REQUEST,
  headers: {},
  body: BODY,
  pruned: {
    arrays: [{ pointer: '/data', total: 2, shown: 2 }],
    strings: 0,
    depthCut: false,
    nodesCut: false,
  },
  detections: DETECT,
  page: { index: 1, from: 1, to: 2, overlap: 0, next: 'tok' },
  ...over,
});
const fail = (errorCode: string, over: Record<string, unknown> = {}) => ({
  ok: false,
  errorCode,
  durationMs: 40,
  request: null,
  headers: {},
  pruned: null,
  detections: null,
  page: null,
  ...over,
});

async function open(
  answers: unknown[],
  patches: Record<string, unknown>[] = [],
  posts: Record<string, unknown>[] = [],
) {
  let n = 0;
  await renderApp('/admin/connections/c1?tab=config', {
    session: 'admin',
    memberships: [membership],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/connectors/http-json': () => json(REST),
      '/api/v1/connections/c1/probe': (_u: URL, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)));
        return json(answers[Math.min(n++, answers.length - 1)]);
      },
      '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'PATCH')
          patches.push(JSON.parse(String(init?.body)));
        return json(connectionDetail({ config: stored }));
      },
    } satisfies Record<string, FetchHandler>,
  });
}
const fetchSample = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: 'Fetch sample' }));

describe('REST explorer', () => {
  it('picks the detections, with their confidence, and proves page 2', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await open(
      [ok(), ok(), ok({ page: { index: 2, from: 3, to: 4, overlap: 0, next: null } })],
      [],
      posts,
    );
    await fetchSample(user);
    const chips = await screen.findByRole('group', { name: 'Suggestions' });
    expect(
      within(chips).getByRole('button', { name: /Records.*\/data · 2.*high/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: /Pagination.*Cursor.*high/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(chips).getByRole('button', { name: /ID.*\/id/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(chips).getByRole('button', { name: /Updated.*iso/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Cursor' })).toBeChecked();
    expect(screen.getByLabelText('Cursor', { selector: 'input[type=text]' })).toHaveValue(
      '/meta/next_cursor',
    );
    // The first fetch applied the detections and fetched again with them.
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.config).toMatchObject({ list: { pagination: { style: 'cursor' } } });
    await user.click(await screen.findByRole('button', { name: 'Fetch page 2' }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]?.next).toBe('tok');
    expect(await screen.findByText(/1–2 · 3–4 · no repeats/)).toBeVisible();
  });

  it('warns when page 2 repeats records', async () => {
    const user = userEvent.setup();
    await open([ok(), ok(), ok({ page: { index: 2, from: 3, to: 4, overlap: 2, next: null } })]);
    await fetchSample(user);
    await user.click(await screen.findByRole('button', { name: 'Fetch page 2' }));
    expect(await screen.findByText(/2 repeated from page 1/)).toBeVisible();
  });

  it('sets the holder email from a clicked field and shows its JSONPath', async () => {
    const user = userEvent.setup();
    await open([ok()]);
    await fetchSample(user);
    await user.click(await screen.findByRole('treeitem', { name: /^email, "a@x.com"/ }));
    expect(screen.getByText('$.data[*].email')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Use as holder email' }));
    expect(screen.getByLabelText('Holder email')).toHaveValue('/email');
    expect(screen.getByRole('treeitem', { name: /^email, "a@x.com", Email/ })).toBeVisible();
  });

  it('is accessible with a sample on screen', async () => {
    const user = userEvent.setup();
    await open([ok()]);
    await fetchSample(user);
    await screen.findByRole('tree', { name: 'Response' });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it.each([
    ['UNSAFE_URL', {}, "PassBook can't call this address. Use a public https URL."],
    [
      'RATE_LIMITED',
      { retryAfterMs: 12_000 },
      'The API asked us to slow down (429). Try again in 12 s.',
    ],
    [
      'OFF_ORIGIN',
      {},
      'The next page is on another host. PassBook follows links on api.example.com only.',
    ],
    ['TOO_LARGE', {}, 'The page is over 512 KiB. Set a smaller page size.'],
  ])('shows %s as one line', async (code, extra, line) => {
    const user = userEvent.setup();
    await open([fail(code, extra)]);
    await fetchSample(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(line);
    expect(alert).toHaveTextContent(code);
  });

  it('offers the candidates when there are no records', async () => {
    const user = userEvent.setup();
    const det = { ...DETECT, pagination: [], id: [], updatedAt: [], holderEmail: [], fields: [] };
    await open([ok({ ok: false, errorCode: 'NO_RECORDS', page: null, detections: det })]);
    await fetchSample(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No list at this path. Pick the records array in the response.',
    );
    expect(screen.getByRole('button', { name: /Records.*\/data/ })).toBeVisible();
  });

  it('saves the pagination it shows with the rest of the configuration', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await open([ok()], patches);
    await user.click(await screen.findByRole('radio', { name: 'Offset' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.config).toMatchObject({
      list: {
        path: '/members',
        pagination: { style: 'offset', param: 'offset', sizeParam: 'limit', size: 100 },
      },
    });
  });

  it('holds the save while the filter has no parameter', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await open([ok()], patches);
    await user.click(await screen.findByRole('switch', { name: 'Only fetch changes' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name the query parameter.')).toBeVisible();
    expect(patches).toHaveLength(0);
  });
});
