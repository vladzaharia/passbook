import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { AXE_MATRIX, axeAt } from '../../../tags/test-fixtures.tsx';
import { bodyOf, KEY, openKeys, posted, supplierFixture } from './test-fixtures.tsx';

afterEach(() => vi.restoreAllMocks());

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

describe('Import tags', () => {
  it('checks the file first, lists skipped rows, then imports the ready ones', async () => {
    const { user, dialog, upload, fetchMock } = await openImport();
    const go = within(dialog).getByRole('button', { name: 'Import 0 tags' });
    expect(go).toBeDisabled();
    await upload();
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
    expect(within(dialog).getByRole('button', { name: 'Import 0 tags' })).toBeDisabled();
  });

  it('cannot import when no row is ready', async () => {
    const { dialog, upload } = await openImport(() => json({ ...dry, ok: 0, rows: 1 }));
    await upload();
    expect(await within(dialog).findByText('0 of 1 rows ready')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import 0 tags' })).toBeDisabled();
  });

  it.each(AXE_MATRIX)(
    'has no axe violations at %i, %s',
    async (width, theme) => {
      const { dialog, upload } = await openImport();
      expect(await axeAt(document.body, width, theme)).toEqual([]);
      await upload();
      await within(dialog).findByText('2 of 3 rows ready');
      expect(await axeAt(document.body, width, theme)).toEqual([]);
    },
    20_000,
  );
});
