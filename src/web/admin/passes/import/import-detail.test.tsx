import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { body, open, setupImportDom } from './import-open-fixtures.ts';
import { COUNTS, checked, finished, importDto, json } from './import-test-fixtures.ts';

setupImportDom();

describe('progress and results', () => {
  it('counts "120 of 160", then shows the results and stops polling', async () => {
    let calls = 0;
    let done = false;
    await open(importDto(), {
      '/api/v1/pass-imports/imp1': () => {
        calls += 1;
        return json(
          done
            ? finished()
            : importDto({
                state: 'committing',
                plan: checked().plan,
                counts: checked().counts,
                committedAt: 1,
                progress: {
                  done: 120,
                  created: 100,
                  updated: 20,
                  unchanged: 0,
                  failed: 0,
                  notEmailed: 0,
                  removed: 0,
                },
              }),
        );
      },
    });
    expect(await screen.findByText(/120 of 160/)).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Passes handled' });
    expect(bar.getAttribute('aria-valuenow')).toBe('120');
    done = true;
    expect(await screen.findByText('172 done', undefined, { timeout: 5000 })).toBeTruthy();
    const settled = calls;
    await new Promise((r) => setTimeout(r, 2600));
    expect(calls).toBe(settled);
  }, 15_000);

  it('shows the counts, the failed rows, and downloads the results', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    await open(
      finished({
        progress: {
          done: 160,
          created: 118,
          updated: 40,
          unchanged: 12,
          failed: 2,
          notEmailed: 5,
          removed: 0,
        },
      }),
      {
        '/api/v1/pass-imports/imp1/rows': () =>
          json({
            items: [
              {
                row: 7,
                action: 'create',
                state: 'failed',
                result: null,
                passId: null,
                externalId: 'A7',
                code: 'CREATE_STALE',
                message: 'That External ID is in use.',
                emailed: false,
              },
            ],
            nextCursor: null,
          }),
        '/api/v1/pass-imports/imp1/results.csv': (u) => {
          seen.push(u.pathname);
          return new Response('Row', { headers: { 'content-type': 'text/csv' } });
        },
      },
    );
    expect(await screen.findByText('That External ID is in use.')).toBeTruthy();
    const stats = screen.getByText('Created').closest('div') as HTMLElement;
    expect(within(stats).getByText('118')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download results' }));
    await waitFor(() => expect(seen).toEqual(['/api/v1/pass-imports/imp1/results.csv']));
  });

  it('says what was skipped, offers the file, and links to the passes of this import', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    await open(finished({ counts: { ...COUNTS, errors: 1 }, errorFile: true }), {
      '/api/v1/pass-imports/imp1/errors.csv': (u) => {
        seen.push(u.pathname);
        return new Response('Row', { headers: { 'content-type': 'text/csv' } });
      },
    });
    await user.click(await screen.findByRole('button', { name: '1 skipped row' }));
    await waitFor(() => expect(seen).toEqual(['/api/v1/pass-imports/imp1/errors.csv']));
    const link = screen.getByRole('link', { name: 'View passes' });
    expect(link.getAttribute('href')).toContain('importId=imp1');
  });

  it('emails the rest through the server, page by page, and says how many were held back', async () => {
    const user = userEvent.setup();
    const cursors: unknown[] = [];
    await open(
      finished({
        progress: {
          done: 3,
          created: 3,
          updated: 0,
          unchanged: 0,
          failed: 0,
          notEmailed: 2,
          removed: 0,
        },
      }),
      {
        '/api/v1/pass-imports/imp1/email-rest': (_u, init) => {
          const { cursor } = body(init);
          cursors.push(cursor);
          return json(
            cursor === null
              ? { sent: 50, skipped: 0, nextCursor: '51' }
              : { sent: 10, skipped: 4, nextCursor: null },
          );
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Email the rest' }));
    expect(cursors).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(cursors).toEqual([null, '51']));
    expect(await screen.findByText(/60 emailed\. 4 held back/)).toBeTruthy();
  });

  it('hides the mail, download and undo actions from a member who cannot operate', async () => {
    await open(
      finished({
        errorFile: true,
        progress: {
          done: 3,
          created: 3,
          updated: 0,
          unchanged: 0,
          failed: 0,
          notEmailed: 2,
          removed: 0,
        },
      }),
      {},
      ['passes:read'],
    );
    await screen.findByText('Created');
    for (const name of ['Download results', 'Email the rest', 'Undo import'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('says how many failed rows are listed when there are more', async () => {
    await open(
      finished({
        state: 'failed',
        progress: {
          done: 160,
          created: 100,
          updated: 40,
          unchanged: 12,
          failed: 120,
          notEmailed: 0,
          removed: 0,
        },
      }),
      {
        '/api/v1/pass-imports/imp1/rows': () =>
          json({
            items: Array.from({ length: 100 }, (_, i) => ({
              row: i + 2,
              action: 'create',
              state: 'failed',
              result: null,
              passId: null,
              externalId: null,
              code: 'X',
              message: `Problem ${i}`,
              emailed: false,
            })),
            nextCursor: '101',
          }),
      },
    );
    expect(await screen.findByText('Showing the first 100 of 120.')).toBeTruthy();
  });

  it('undoes the import after a confirm, and says what it removed and restored', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(finished({ finishedAt: Date.now() }), {
      '/api/v1/pass-imports/imp1/undo': (_u, init) => {
        posts.push(body(init));
        return json({
          state: 'done',
          removed: 120,
          restored: 40,
          keptTotal: 2,
          kept: [],
          emailsCancelled: 0,
        });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Undo import' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this import?' });
    await user.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    expect(await screen.findByText(/Removed 120 · Restored 40 · 0 emails cancelled/)).toBeTruthy();
    expect(screen.getByText('Kept 2, changed since.')).toBeTruthy();
    expect(posts).toHaveLength(1);
  });

  it('stops offering Change these and Download results once the import is undone', async () => {
    const user = userEvent.setup();
    await open(finished({ finishedAt: Date.now() }), {
      '/api/v1/pass-imports/imp1/undo': () =>
        json({
          state: 'done',
          removed: 120,
          restored: 40,
          keptTotal: 0,
          kept: [],
          emailsCancelled: 0,
        }),
    });
    expect(await screen.findByRole('link', { name: 'Change these' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Undo import' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this import?' });
    await user.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    await screen.findByText(/Removed 120/);
    expect(screen.queryByRole('link', { name: 'Change these' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download results' })).toBeNull();
    expect(screen.queryByText('Created')).toBeNull();
  });

  it('says so when the undo failed, and keeps the button', async () => {
    const user = userEvent.setup();
    await open(finished({ finishedAt: Date.now() }), {
      '/api/v1/pass-imports/imp1/undo': () =>
        json({
          state: 'failed',
          removed: 0,
          restored: 0,
          keptTotal: 0,
          kept: [],
          emailsCancelled: 0,
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'Undo import' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this import?' });
    await user.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    expect(await screen.findByText('The undo did not finish. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo import' })).toBeTruthy();
  });

  it('names the updates that cannot be undone', async () => {
    const user = userEvent.setup();
    await open(finished({ finishedAt: Date.now() }), {
      '/api/v1/pass-imports/imp1/undo': () =>
        json({
          state: 'done',
          removed: 5,
          restored: 1,
          keptTotal: 0,
          kept: [],
          emailsCancelled: 0,
          unrevertable: 3,
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'Undo import' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this import?' });
    await user.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    expect(await screen.findByText("3 updates can't be undone.")).toBeTruthy();
  });

  it('shows an undo the server already ran, from the import itself', async () => {
    await open(
      finished({
        finishedAt: Date.now(),
        undo: {
          state: 'done',
          removed: 7,
          restored: 2,
          keptTotal: 0,
          kept: [],
          emailsCancelled: 5,
        },
      }),
    );
    expect(await screen.findByText(/Removed 7 · Restored 2 · 5 emails cancelled/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo import' })).toBeNull();
  });

  it('names updates that cannot be undone before the undo', async () => {
    await open(finished({ finishedAt: Date.now(), unrevertable: 4 }));
    expect(await screen.findByText(/4 updates can't be undone\./)).toBeTruthy();
  });

  it('counts down to the held emails, with Send now', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    await open(
      finished({
        emailHoldUntil: Date.now() + 4 * 60_000 + 44_000,
        finishedAt: Date.now(),
        progress: {
          done: 160,
          created: 120,
          updated: 40,
          unchanged: 12,
          failed: 0,
          skipped: 0,
          notEmailed: 93,
          removed: 0,
        },
      }),
      {
        '/api/v1/pass-imports/imp1/email-rest': (_u, init) => {
          sent.push(body(init));
          return json({ sent: 93, skipped: 0, nextCursor: null });
        },
      },
    );
    expect(await screen.findByText(/until 93 emails go out/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email the rest' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it('offers no undo a day after the import finished', async () => {
    await open(finished());
    await screen.findByText('Created');
    expect(screen.queryByRole('button', { name: 'Undo import' })).toBeNull();
  });

  it('hides Undo when everything created is already removed and nothing was updated', async () => {
    await open(
      finished({
        finishedAt: Date.now(),
        progress: {
          done: 160,
          created: 120,
          updated: 0,
          unchanged: 12,
          failed: 0,
          notEmailed: 0,
          removed: 120,
        },
      }),
    );
    await screen.findByText('Created');
    expect(screen.queryByRole('button', { name: 'Undo import' })).toBeNull();
  });

  it.each([
    ['a sheet link in Live for an integrations manager', 'url', 'live', undefined, true],
    ['without integrations:manage', 'url', 'live', ['passes:read', 'passes:operate'], false],
    ['a file source', 'file', 'live', undefined, false],
    ['Test mode', 'url', 'test', undefined, false],
  ])('keep in sync: %s', async (_name, kind, mode, caps, shown) => {
    await open(finished({ source: { kind, name: 'docs.google.com' }, mode }), {}, caps);
    await screen.findByText('Created');
    expect(!!screen.queryByRole('link', { name: 'Keep this sheet in sync' })).toBe(shown);
  });
});

describe('other states', () => {
  it('says an expired import is gone', async () => {
    await open(importDto({ state: 'expired' }));
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import another' })).toBeTruthy();
  });

  it('shows the checking state', async () => {
    await open(importDto({ state: 'checking' }));
    // The shell has its own empty live region, so the role alone matches two nodes and findBy retries to timeout.
    expect(await screen.findByText('Checking rows')).toBeTruthy();
  });

  it('shows a load failure with retry', async () => {
    await open(importDto(), {
      '/api/v1/pass-imports/imp1': () =>
        json(
          {
            type: 'about:blank',
            title: 'Error',
            status: 500,
            code: 'INTERNAL',
            detail: 'Something broke.',
          },
          500,
        ),
    });
    expect(await screen.findByRole('button', { name: /Retry|Try again/ })).toBeTruthy();
  });

  it('shows an unknown import as an error, not a blank page', async () => {
    await open(importDto(), {
      '/api/v1/pass-imports/imp1': () =>
        json(
          {
            type: 'about:blank',
            title: 'Not found',
            status: 404,
            code: 'IMPORT_NOT_FOUND',
            detail: 'Import not found.',
          },
          404,
        ),
    });
    expect(await screen.findByText(/Import not found/)).toBeTruthy();
  });
});
