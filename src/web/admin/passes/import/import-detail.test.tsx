import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import {
  baseHandlers,
  COUNTS,
  checked,
  finished,
  importDto,
  json,
  ORG,
} from './import-test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const body = (init?: RequestInit) => JSON.parse(String(init?.body));

type Handler = (u: URL, init?: RequestInit) => Response;

/** Opens /admin/passes/import/imp1 with `imp` served until a handler changes it. */
async function open(
  imp: Record<string, unknown>,
  extra: Record<string, Handler> = {},
  caps?: string[],
) {
  return renderApp('/admin/passes/import/imp1', {
    session: 'admin',
    memberships: [caps ? membershipFixture(ORG.id, { capabilities: caps as never }) : membership],
    selectedOrg: ORG.id,
    handlers: { ...baseHandlers(), '/api/v1/pass-imports/imp1': () => json(imp), ...extra },
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  resetModeForTests();
});

describe('match columns', () => {
  it('maps by name on open, pins Holder email and External ID, and posts the plan', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(importDto(), {
      '/api/v1/pass-imports/imp1/check': (_u, init) => {
        posts.push(body(init));
        return json(checked());
      },
    });
    expect(await screen.findByText('Match columns')).toBeTruthy();
    expect(screen.getAllByText('Holder email').length).toBeGreaterThan(0);
    expect(screen.getAllByText('External ID').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      plan: {
        mapping: { name: { from: '/Name' }, level: { from: '/Level' } },
        holderEmail: { from: '/Email' },
        externalId: { from: '/Id' },
        match: 'externalId',
        keepManual: false,
        save: true,
      },
    });
  });

  it('refuses to match on an External ID that is not mapped', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(importDto({ columns: [{ pointer: '/Name', label: 'Name', samples: ['Maya'] }] }), {
      '/api/v1/pass-imports/imp1/check': (_u, init) => {
        posts.push(body(init));
        return json(checked());
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Map an External ID column to match on it.')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("hides the keep-edited switch for Don't match", async () => {
    const user = userEvent.setup();
    await open(importDto());
    await screen.findByText('Match columns');
    expect(screen.getByText("Don't overwrite edits made in the console")).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Find passes by' }));
    await user.click(await screen.findByRole('option', { name: "Don't match" }));
    expect(screen.queryByText("Don't overwrite edits made in the console")).toBeNull();
  });

  it('shows the check failure', async () => {
    const user = userEvent.setup();
    await open(importDto(), {
      '/api/v1/pass-imports/imp1/check': () =>
        json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'IMPORT_STATE',
            detail: 'The import changed. Reload.',
          },
          409,
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByText('The import changed. Reload.')).toBeTruthy();
  });
});

describe('check', () => {
  it('shows the counts line, previews of the planned input and the problems', async () => {
    const previews: unknown[] = [];
    await open(checked(), {
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
    expect(
      await screen.findByText('120 to create · 40 to update · 12 unchanged · 3 errors'),
    ).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Update')).toBeTruthy();
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[0]).toMatchObject({ input: { name: 'Maya' }, version: 'a1b2c3d4e5f6a7b8' });
    const table = screen.getByRole('table', { name: 'Problems' });
    expect(within(table).getByText('Email is not valid.')).toBeTruthy();
    expect(within(table).getByText('Warning')).toBeTruthy();
  });

  it('downloads the rows with errors through an authenticated request', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const { fetchMock } = await open(checked(), {
      '/api/v1/pass-imports/imp1/errors.csv': (u) => {
        seen.push(u.search);
        return new Response('a,Problem', { headers: { 'content-type': 'text/csv' } });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Download rows with errors' }));
    await waitFor(() => expect(seen).toEqual(['?orgId=org1']));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('gates commit on skipping the rows with errors, and posts the email choice', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked(), {
      '/api/v1/pass-imports/imp1/commit': (_u, init) => {
        posts.push(body(init));
        return json(
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
          }),
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: /^(Create|Update) \d+/ }));
    const go = await screen.findByRole('button', { name: 'Create 120 and update 40' });
    expect(go).toHaveProperty('disabled', false);
    expect(
      screen.getByText('The first 80 get an email. The rest are listed after the import.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Email new holders' }));
    await user.click(go);
    await waitFor(() => expect(posts).toEqual([{ skipInvalid: true, email: true }]));
    expect(await screen.findByText('0 of 160')).toBeTruthy();
  });

  it('shows the plain budget when it covers everyone, and no switch when nobody has an email', async () => {
    const user = userEvent.setup();
    await open(checked({ counts: { ...COUNTS, errors: 0, emailable: 50 } }));
    await user.click(await screen.findByRole('button', { name: /^(Create|Update) \d+/ }));
    expect(await screen.findByText('You can send 80 more pass emails today.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('offers a re-check when the template moved, and blocks commit meanwhile', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await open(checked({ state: 'stale' }), {
      '/api/v1/pass-imports/imp1/check': (_u, init) => {
        posts.push(body(init));
        return json(checked());
      },
    });
    expect(await screen.findByText('The template changed. Check again to finish.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(Create|Update) \d+/ })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('goes back to the columns', async () => {
    const user = userEvent.setup();
    await open(checked());
    await user.click(await screen.findByRole('button', { name: 'Change columns' }));
    expect(await screen.findByText('Match columns')).toBeTruthy();
  });

  it('discards the draft and returns to the import page', async () => {
    const user = userEvent.setup();
    const deletes: string[] = [];
    const { router } = await open(checked(), {
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
});

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
    expect(await screen.findByText('120 of 160')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Passes handled' });
    expect(bar.getAttribute('aria-valuenow')).toBe('120');
    expect(screen.getByText('You can leave this page.')).toBeTruthy();
    done = true;
    expect(await screen.findByText('All rows done.', undefined, { timeout: 5000 })).toBeTruthy();
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

  it('says what was skipped, lists it, and links to the passes of this import', async () => {
    await open(
      finished({
        counts: { ...COUNTS, errors: 1 },
        problems: [
          {
            row: 4,
            column: 'Tier',
            field: 'tier',
            code: 'INPUT',
            severity: 'error',
            message: 'Tier must be Plus or Pro.',
          },
        ],
        problemTotals: { errors: 1, warnings: 0 },
      }),
    );
    expect(await screen.findByText('172 rows done, 1 skipped.')).toBeTruthy();
    expect(screen.getByText('Skipped rows')).toBeTruthy();
    expect(screen.getByText('Tier must be Plus or Pro.')).toBeTruthy();
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

  it('hides the mail and download actions from a member who cannot operate, but keeps the error file', async () => {
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
    await screen.findByText('Results');
    for (const name of ['Download results', 'Email the rest', 'Remove created passes'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download rows with errors' })).toBeTruthy();
  });

  it('hides Create, Discard and Change columns from a member who cannot operate', async () => {
    await open(checked(), {}, ['passes:read']);
    await screen.findByText(/120 to create/);
    for (const name of [/^(Create|Update) \d+/, 'Discard', 'Change columns'])
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

  it('removes the created passes page by page after a confirm', async () => {
    const user = userEvent.setup();
    const cursors: unknown[] = [];
    await open(finished(), {
      '/api/v1/pass-imports/imp1/remove-created': (_u, init) => {
        const { cursor } = body(init);
        cursors.push(cursor);
        return json(
          cursor === null
            ? { removed: 50, skipped: [], nextCursor: '51' }
            : {
                removed: 70,
                skipped: [{ passId: 'p9', code: 'IMPORT_PASS_SCANNED' }],
                nextCursor: null,
              },
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove created passes' }));
    expect(await screen.findByText('Remove created passes?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(cursors).toEqual([null, '51']));
    expect(await screen.findByText(/120 passes removed/)).toBeTruthy();
  });

  it('hides Remove created when everything created is already removed', async () => {
    await open(
      finished({
        progress: {
          done: 160,
          created: 120,
          updated: 40,
          unchanged: 12,
          failed: 0,
          notEmailed: 0,
          removed: 120,
        },
      }),
    );
    await screen.findByText('Results');
    expect(screen.queryByRole('button', { name: 'Remove created passes' })).toBeNull();
  });

  it.each([
    ['a sheet link in Live for an integrations manager', 'url', 'live', undefined, true],
    ['without integrations:manage', 'url', 'live', ['passes:read', 'passes:operate'], false],
    ['a file source', 'file', 'live', undefined, false],
    ['Test mode', 'url', 'test', undefined, false],
  ])('keep in sync: %s', async (_name, kind, mode, caps, shown) => {
    await open(finished({ source: { kind, name: 'docs.google.com' }, mode }), {}, caps);
    await screen.findByText('Results');
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
    expect(await screen.findByRole('status')).toBeTruthy();
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
