import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { body, method, open, setupImportDom } from './import-open-fixtures.ts';
import { COUNTS, checked, importDto, json } from './import-test-fixtures.ts';

setupImportDom();

const committing = () =>
  importDto({
    state: 'committing',
    plan: checked().plan,
    counts: checked().counts,
    committedAt: 1,
    progress: {
      done: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      notEmailed: 0,
      removed: 0,
    },
  });

const ROWS = {
  items: [
    {
      row: 3,
      action: 'update',
      state: 'planned',
      result: null,
      passId: 'p1',
      externalId: 'M-200',
      code: null,
      message: null,
      emailed: false,
      changes: [{ key: 'level', label: 'Level', from: 'Copper', to: 'Blue' }],
    },
  ],
  nextCursor: null,
};

describe('check', () => {
  it('shows the four counts as filters, the cards of new passes and the problems', async () => {
    const user = userEvent.setup();
    const previews: unknown[] = [];
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/templates/tpl1/preview': (_u, init) => {
        previews.push(body(init));
        return json({
          passJson: { formatVersion: 1, organizationName: 'H', description: 'M', generic: {} },
          warnings: [],
          assetBaseUrl: '/a',
          assetNames: [],
        });
      },
    });
    const tiles = await screen.findAllByRole('button', { pressed: false });
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(await screen.findByRole('button', { name: /Needs a fix/ })).toBeTruthy();
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(previews[0]).toMatchObject({ input: { name: 'Maya' }, version: 'a1b2c3d4e5f6a7b8' });
    const table = screen.getByRole('table', { name: 'Problems' });
    expect(within(table).getByText('Email is not valid.')).toBeTruthy();
    expect(within(table).getByText('bad@')).toBeTruthy();
    const diff = await screen.findByText('M-200');
    expect(diff).toBeTruthy();
    expect(screen.getByText('Copper')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Updates/ }));
    expect(screen.queryByRole('table', { name: 'Problems' })).toBeNull();
  });

  it('fixes a cell in place and checks again with the fix in the plan', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/check': (_u, init) => {
        posts.push(body(init));
        return json(checked({ counts: { ...COUNTS, errors: 0 }, problems: [] }));
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Fix Email on row 14' }));
    const box = screen.getByRole('textbox', { name: 'Fix Email on row 14' });
    expect((box as HTMLInputElement).value).toBe('bad@');
    await user.clear(box);
    await user.type(box, 'a@b.co{Enter}');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ plan: { overrides: { 14: { '/Email': 'a@b.co' } } } });
  });

  it('shows everything again when the pressed filter has no rows left', async () => {
    const user = userEvent.setup();
    let fixed = false;
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/check': () => {
        fixed = true;
        return json(checked({ counts: { ...COUNTS, errors: 0 }, problems: [] }));
      },
    });
    await user.click(await screen.findByRole('button', { name: /Needs a fix/ }));
    await user.click(screen.getByRole('button', { name: 'Fix Email on row 14' }));
    await user.type(screen.getByRole('textbox', { name: 'Fix Email on row 14' }), 'a@b.co{Enter}');
    await waitFor(() => expect(fixed).toBe(true));
    expect(await screen.findByText('M-200')).toBeTruthy();
  });

  it('hides Create, Check again and Discard once the server says the import was undone', async () => {
    const user = userEvent.setup();
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/commit': () =>
        json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'IMPORT_UNDONE',
            detail: 'Undone.',
          },
          409,
        ),
    });
    await user.click(await screen.findByRole('button', { name: /^(Create|Update) \d+/ }));
    expect(await screen.findByText('This import was undone.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('button', { name: /^(Create|Update) \d+/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('downloads the rows with errors through an authenticated request', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/errors.csv': (u) => {
        seen.push(u.search);
        return new Response('a,Problem', { headers: { 'content-type': 'text/csv' } });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Download rows with errors' }));
    await waitFor(() => expect(seen).toEqual(['?orgId=org1']));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('commits skipping the rows with errors, and holds the email for five minutes', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/commit': (_u, init) => {
        posts.push(body(init));
        return json(committing());
      },
    });
    await user.click(await screen.findByRole('switch', { name: 'Email new holders' }));
    expect(screen.getByRole('combobox', { name: /Send/ }).textContent).toContain('After 5 min');
    expect(screen.getByText('Undo before then and no one is emailed.')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Create 120 and update 40 (skip 3 errors)' }),
    );
    await waitFor(() =>
      expect(posts).toEqual([{ skipInvalid: true, email: { send: 'held', holdMs: 300_000 } }]),
    );
    expect(await screen.findByText(/0 of 160/)).toBeTruthy();
  });

  it('sends at once when Now is chosen, and sends no email when the switch is off', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked({ counts: { ...COUNTS, errors: 0 }, problems: [] }), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/commit': (_u, init) => {
        posts.push(body(init));
        return json(committing());
      },
    });
    await user.click(await screen.findByRole('switch', { name: 'Email new holders' }));
    await user.click(screen.getByRole('combobox', { name: /Send/ }));
    await user.click(await screen.findByRole('option', { name: 'Now' }));
    await user.click(screen.getByRole('button', { name: 'Create 120 and update 40' }));
    await waitFor(() => expect(posts).toEqual([{ skipInvalid: false, email: { send: 'now' } }]));
  });

  it('shows no email switch when nobody has an email', async () => {
    await open(checked({ counts: { ...COUNTS, errors: 0, emailable: 0 } }), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
    });
    const sw = await screen.findByRole('switch', { name: 'Email new holders' });
    expect(sw).toHaveProperty('disabled', true);
    expect(screen.getByText('No new holder has an email.')).toBeTruthy();
  });

  it('offers a re-check when the template moved, and blocks commit meanwhile', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked({ state: 'stale' }), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1/check': (_u, init) => {
        posts.push(body(init));
        return json(checked());
      },
    });
    expect(await screen.findByText('The template changed. Check again to finish.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(Create|Update) \d+/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('goes back to the columns', async () => {
    const user = userEvent.setup();
    await open(checked(), { '/api/v1/pass-imports/imp1/rows': () => json(ROWS) });
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Match columns')).toBeTruthy();
  });

  it('discards the draft and returns to the import page', async () => {
    const user = userEvent.setup();
    const deletes: string[] = [];
    const { router } = await open(checked(), {
      '/api/v1/pass-imports/imp1/rows': () => json(ROWS),
      '/api/v1/pass-imports/imp1': (_u, init) => {
        if (method(init) !== 'DELETE') return json(checked());
        deletes.push('imp1');
        return json({ ok: true });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(deletes).toEqual(['imp1']));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/admin\/o\/[^/]+\/passes\/import$/),
    );
  });

  it('hides Create, Discard and the fixes from a member who cannot operate', async () => {
    await open(checked(), { '/api/v1/pass-imports/imp1/rows': () => json(ROWS) }, ['passes:read']);
    await screen.findByRole('button', { name: /Needs a fix/ });
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Fix / })).toBeNull();
    expect(screen.getByRole('button', { name: /^(Create|Update) \d+/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
