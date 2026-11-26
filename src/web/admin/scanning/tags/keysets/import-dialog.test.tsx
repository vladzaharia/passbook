import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissStepUp } from '@/web/lib/step-up.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { AXE_MATRIX, axeAt } from '../../../tags/test-fixtures.tsx';
import { bodyOf, KEY, openKeys, posted, supplierFixture } from './test-fixtures.tsx';

afterEach(() => {
  dismissStepUp();
  vi.restoreAllMocks();
});

const CSV = `uid,key\n04aa0000000001,${KEY}\n04aa0000000002,${KEY}\nnope,${KEY}\n`;
const dry = {
  dryRun: true,
  rows: 3,
  ok: 2,
  added: 0,
  moreProblems: 0,
  problems: [{ line: 4, uid: null, reason: 'bad_uid' }],
};
const real = { ...dry, dryRun: false, added: 2 };

function file(text = CSV) {
  const f = new File([text], 'tags.csv', { type: 'text/csv' });
  // jsdom has no Blob.text.
  Object.defineProperty(f, 'text', { value: () => Promise.resolve(text) });
  return f;
}

async function openImport(answer: (dryRun: boolean) => Response = (d) => json(d ? dry : real)) {
  const user = userEvent.setup();
  const rendered = await openKeys([supplierFixture()], {
    '/api/v1/nfc/keysets/k2/import': (_u, init) => answer(JSON.parse(String(init?.body)).dryRun),
  });
  await user.click(await screen.findByRole('button', { name: 'Supplier tags' }));
  await user.click(await screen.findByRole('button', { name: 'Import tags' }));
  const dialog = await screen.findByRole('dialog', { name: /Import tags to Supplier tags/ });
  const upload = () =>
    user.upload(dialog.querySelector('input[type="file"]') as HTMLElement, file());
  return { user, dialog, upload, ...rendered };
}

/** Next turns on once the dry run is back; it opens the Check step. */
async function toCheck(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  const next = within(dialog).getByRole('button', { name: 'Next' });
  await waitFor(() => expect(next).not.toHaveAttribute('aria-disabled'));
  await user.click(next);
  await within(dialog).findByRole('heading', { name: 'Check the rows' });
}

describe('Import tags', () => {
  it('checks the file first, lists skipped rows, then imports the ready ones', async () => {
    const { user, dialog, upload, fetchMock } = await openImport();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await upload();
    await toCheck(user, dialog);
    expect(await within(dialog).findByText('2 of 3 rows ready')).toBeInTheDocument();
    const table = within(dialog).getByRole('table', { name: 'Rows that will be skipped' });
    expect(within(table).getByText("Isn't a 7-byte tag ID")).toBeInTheDocument();
    expect(posted(fetchMock, '/k2/import')).toHaveLength(1);
    expect(bodyOf(posted(fetchMock, '/k2/import')[0])).toEqual({ csv: CSV, dryRun: true });
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 tags' }));
    await waitFor(() => expect(posted(fetchMock, '/k2/import')).toHaveLength(2));
    expect(bodyOf(posted(fetchMock, '/k2/import')[1])).toEqual({ csv: CSV, dryRun: false });
    expect(await screen.findByText('2 tags imported')).toBeInTheDocument();
    // Neither the file nor any key is shown back.
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('replaces keys: dry run with replace, confirm with the count, then toast', async () => {
    const { user, dialog, upload, fetchMock } = await openImport();
    await upload();
    await waitFor(() => expect(posted(fetchMock, '/k2/import')).toHaveLength(1));
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'Replace keys for tags already on this keyset',
      }),
    );
    await waitFor(() => expect(posted(fetchMock, '/k2/import')).toHaveLength(2));
    await toCheck(user, dialog);
    expect(await within(dialog).findByText('2 of 3 rows will re-key a tag')).toBeInTheDocument();
    expect(bodyOf(posted(fetchMock, '/k2/import')[1])).toEqual({
      csv: CSV,
      dryRun: true,
      replace: true,
    });
    // The danger finish says what it costs; there is no second confirm.
    expect(within(dialog).getByText(/Taps with the old keys stop working/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Re-key 2 tags' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(posted(fetchMock, '/k2/import')).toHaveLength(3));
    expect(bodyOf(posted(fetchMock, '/k2/import')[2])).toEqual({
      csv: CSV,
      dryRun: false,
      replace: true,
    });
    expect(await screen.findByText('2 tags re-keyed')).toBeInTheDocument();
  });

  it('shows the server’s refusal of a file and keeps Import off', async () => {
    const { dialog, upload } = await openImport(() =>
      json(
        {
          type: 'about:blank#IMPORT_HEADER',
          title: 'x',
          status: 422,
          code: 'IMPORT_HEADER',
          detail: 'The first line needs uid and key columns.',
        },
        422,
      ),
    );
    await upload();
    expect(
      await within(dialog).findByText('The first line needs uid and key columns.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(dialog).queryByRole('heading', { name: 'Check the rows' })).toBeNull();
  });

  it('says 1 tag, not 1 tags', async () => {
    const { user, dialog, upload } = await openImport((d) =>
      json(d ? { ...dry, rows: 1, ok: 1, problems: [] } : { ...real, added: 1 }),
    );
    await upload();
    await toCheck(user, dialog);
    expect(await within(dialog).findByText('1 of 1 row ready')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 tag' }));
    expect(await screen.findByText('1 tag imported')).toBeInTheDocument();
  });

  it('shows no error line when the server asks for a recent sign-in', async () => {
    const { user, dialog, upload } = await openImport((d) =>
      d
        ? json({ ...dry, problems: [] })
        : new Response(
            JSON.stringify({
              type: 'about:blank#STEP_UP_REQUIRED',
              title: 'STEP_UP_REQUIRED',
              status: 403,
              code: 'STEP_UP_REQUIRED',
              detail: 'Sign in again to confirm it is you.',
              signInUrl: '/auth/oidc/start?prompt=login&max_age=0&next=%2Fadmin',
            }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } },
          ),
    );
    await upload();
    await toCheck(user, dialog);
    await within(dialog).findByText('2 of 3 rows ready');
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 tags' }));
    expect(
      await screen.findByRole('alertdialog', { name: "Confirm it's you" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert', { hidden: true })).toBeNull();
  });

  it('cannot import when no row is ready', async () => {
    const { user, dialog, upload, fetchMock } = await openImport(() =>
      json({ ...dry, ok: 0, rows: 1 }),
    );
    await upload();
    await toCheck(user, dialog);
    expect(await within(dialog).findByText('0 of 1 row ready')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Import 0 tags' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    await user.click(go);
    expect(within(dialog).getAllByText('No rows are ready.').length).toBeGreaterThan(0);
    expect(posted(fetchMock, '/k2/import')).toHaveLength(1);
  });

  it.each(AXE_MATRIX)(
    'has no axe violations at %i, %s',
    async (width, theme) => {
      const { user, dialog, upload } = await openImport();
      expect(await axeAt(document.body, width, theme)).toEqual([]);
      await upload();
      await toCheck(user, dialog);
      await within(dialog).findByText('2 of 3 rows ready');
      expect(await axeAt(document.body, width, theme)).toEqual([]);
    },
    20_000,
  );
});
