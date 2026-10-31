import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { dayToMs, msToDay, parseAuditSearch } from './audit-search.ts';
import { describeDetail, REDACTED, redact } from './redact.ts';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: 1_700_000_000_000 + id,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  action: `thing.updated.${id}`,
  targetType: 'org',
  targetId: 'o1',
  requestId: 'req-1',
  detail: null,
  ...over,
});

describe('redact', () => {
  it('hides values of secret-looking keys at any depth', () => {
    expect(
      redact({ name: 'a', apiKey: 'x', nested: { password: 'p', list: [{ token: 't', ok: 1 }] } }),
    ).toEqual({
      name: 'a',
      apiKey: REDACTED,
      nested: { password: REDACTED, list: [{ token: REDACTED, ok: 1 }] },
    });
  });
  it('keeps keys that only contain "key" as part of another word', () => {
    expect(redact({ keyboard: 'k', key: 's' })).toEqual({ keyboard: 'k', key: REDACTED });
  });
  it('describes before/after details as a diff and other details as JSON', () => {
    expect(describeDetail(null).kind).toBe('none');
    const diff = describeDetail({ before: { a: 1 }, after: { a: 2, secret: 'z' } });
    expect(diff.kind).toBe('diff');
    expect(diff.after).toContain(REDACTED);
    expect(diff.after).not.toContain('"z"');
    expect(describeDetail({ note: 'x' }).kind).toBe('json');
  });
});

describe('audit search', () => {
  it('parses numbers from strings and rejects junk', () => {
    expect(parseAuditSearch({ from: '100', to: 'abc', entry: 5, action: ' ' })).toMatchObject({
      from: 100,
      to: undefined,
      entry: 5,
      action: undefined,
    });
  });
  it('round-trips a day and makes the end of day inclusive', () => {
    const start = dayToMs('2026-03-04', false)!;
    expect(msToDay(start)).toBe('2026-03-04');
    expect(dayToMs('2026-03-04', true)! - start).toBe(86_400_000 - 1);
    expect(dayToMs('nope', false)).toBeUndefined();
  });
});

describe('audit page', () => {
  it('lists entries, passes URL filters to the API, accessible', async () => {
    const { container, fetchMock } = await renderApp(
      '/admin/audit?action=thing&targetType=org&from=100',
      {
        session: 'admin',
        handlers: { '/api/v1/audit': () => json({ items: [entry(1)], nextCursor: null }) },
      },
    );
    expect(await screen.findByText('thing.updated.1')).toBeInTheDocument();
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/audit?'));
    expect(call).toContain('action=thing');
    expect(call).toContain('targetType=org');
    expect(call).toContain('from=100');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('applies filters to the URL', async () => {
    const { router } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': () => json({ items: [], nextCursor: null }) },
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText('Action'), 'pass.void');
    await ui.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('No entries match');
    expect(router.state.location.search).toMatchObject({ action: 'pass.void' });
  });

  it('paginates with the cursor', async () => {
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit': (url) =>
          url.searchParams.get('cursor') === 'c1'
            ? json({ items: [entry(2)], nextCursor: null })
            : json({ items: [entry(1)], nextCursor: 'c1' }),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('thing.updated.2')).toBeInTheDocument();
    expect(screen.getByText('thing.updated.1')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('cursor=c1'))).toBe(true);
  });

  it('opens a drawer with a redacted diff', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit': () =>
          json({
            items: [
              entry(1, {
                detail: {
                  before: { name: 'A', apiKey: 'hunter2' },
                  after: { name: 'B', apiKey: 'hunter3' },
                },
              }),
            ],
            nextCursor: null,
          }),
      },
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /details for thing.updated.1/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    expect(drawer.textContent).not.toContain('hunter');
    expect(drawer.textContent).toContain(REDACTED);
  });

  it('shows empty and error states', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No entries')).toBeInTheDocument();
  });

  it('shows an error', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
  });
});
