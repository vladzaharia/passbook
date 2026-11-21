import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { MyTag } from '@/shared/contracts/me.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

const NOV_3 = Date.UTC(2026, 10, 3, 12);
const SEP_30 = Date.UTC(2026, 8, 30, 12);
const tag = (over: Partial<MyTag>): MyTag => ({
  id: 't1',
  label: 'Blue fob',
  hint: '7F3A',
  scope: 'user',
  boundAt: NOV_3,
  lostAt: null,
  ...over,
});
const tags = [
  tag({}),
  tag({ id: 't2', label: null, hint: '1B09', scope: 'pass' }),
  tag({ id: 't3', label: 'Old fob', hint: '44C2', lostAt: SEP_30 }),
];

describe('Tags card', () => {
  it('lists masked tags, who they open, and a Lost row without a button', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ tags })) },
    });
    await screen.findByRole('heading', { name: 'Tags' });
    const list = screen.getByRole('list', { name: 'Tags' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Blue fob');
    expect(rows[0]).toHaveTextContent('All your passes · •• 7F3A · Added Nov 3');
    expect(rows[1]).toHaveTextContent('Tag');
    expect(rows[1]).toHaveTextContent('This pass · •• 1B09');
    expect(rows[2]).toHaveTextContent('•• 44C2 · Reported Sep 30');
    expect(rows[2]).toHaveTextContent('Lost');
    expect(within(rows[2] as HTMLElement).queryByRole('button')).toBeNull();
    expect(list.textContent).not.toMatch(/basic|secure/i);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('is absent without tags', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    await waitFor(() => expect(document.querySelector('.wl-holder-details')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: 'Tags' })).toBeNull();
  });

  it('reports lost after a confirm that names the org and the scope', async () => {
    const user = userEvent.setup();
    let lost = false;
    const posted = vi.fn();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(passFixture({ tags: lost ? [tag({ lostAt: SEP_30 })] : [tag({})] })),
        '/api/v1/me/tags/t1/lost': (_url, init) => {
          posted(init?.method);
          lost = true;
          return json({ ok: true });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Report lost' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Report Blue fob lost?')).toBeVisible();
    expect(
      within(dialog).getByText(
        'It stops opening doors on all your passes now. Ask Henrys to restore it or replace it.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Report lost' }));
    expect(await screen.findByText('Blue fob reported lost')).toBeVisible();
    expect(posted).toHaveBeenCalledWith('POST');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Report lost' })).toBeNull());
    expect(screen.getByText('Lost')).toBeVisible();
  });

  it('keeps the dialog open with the error when the report fails', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture({ tags: [tag({ scope: 'pass' })] })),
        '/api/v1/me/tags/t1/lost': () => problem(409, 'TAG_HOLDER_CHANGED', 'The pass changed.'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Report lost' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        'It stops opening doors now. Ask Henrys to restore it or replace it.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Report lost' }));
    expect(await within(dialog).findByText(/changed/i)).toBeVisible();
  });
});
