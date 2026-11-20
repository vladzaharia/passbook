import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { AXE_MATRIX, axeAt } from '../../../tags/test-fixtures.tsx';
import {
  bodyOf,
  keysetFixture,
  openKeys,
  posted,
  reader,
  supplierFixture,
} from './test-fixtures.tsx';

afterEach(() => vi.restoreAllMocks());

const all = () => [keysetFixture(), supplierFixture()];

describe('Secure keys', () => {
  it('lists keysets with their kind, version, tags and status; no key anywhere', async () => {
    await openKeys(all());
    const table = await screen.findByRole('table', { name: 'Secure keysets' });
    const staff = within(table).getByRole('row', { name: /Staff badges/ });
    expect(staff).toHaveTextContent('Key per tag, derived');
    expect(staff).toHaveTextContent('v2 · v1 retiring');
    expect(staff).toHaveTextContent('7');
    expect(within(table).getByRole('row', { name: /Supplier tags/ })).toHaveTextContent(
      'Own key per tag',
    );
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{32}/);
  });

  it('shows an empty state with the one way forward', async () => {
    await openKeys([]);
    expect(await screen.findByText('No Secure keys')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New keyset' })).toBeInTheDocument();
  });

  it('gives a reader the list and no buttons', async () => {
    const user = userEvent.setup();
    await openKeys(all(), {}, '', reader);
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    const sheet = await screen.findByRole('dialog', { name: 'Staff badges' });
    expect(within(sheet).getByText('Version 2 · Active')).toBeInTheDocument();
    for (const name of [/Rotate keys/, /Revoke/, /Disable/, /Move tags/, /Import tags/])
      expect(within(sheet).queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New keyset' })).toBeNull();
  });

  it('opens a keyset with its versions, the tag URL and the tag settings', async () => {
    const user = userEvent.setup();
    await openKeys(all());
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    const sheet = await screen.findByRole('dialog', { name: 'Staff badges' });
    expect(within(sheet).getByText('Version 1 · Retiring')).toBeInTheDocument();
    expect(within(sheet).getByText('2 tags')).toBeInTheDocument();
    expect(within(sheet).getByText(/\/t\/abcd1234$/)).toBeInTheDocument();
    const profile = within(sheet).getByRole('region', { name: 'Tag settings' });
    expect(profile).toHaveTextContent('input the UID only');
    expect(profile).toHaveTextContent('Over empty input');
  });

  it('revokes a version after a confirm that names the tags it leaves', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await openKeys(all(), {
      '/api/v1/nfc/keysets/k1/keys/1/revoke': () => json(keysetFixture()),
    });
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    const sheet = await screen.findByRole('dialog', { name: 'Staff badges' });
    await user.click(within(sheet).getByRole('button', { name: 'Revoke version 1' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Revoke version 1?');
    expect(confirm).toHaveTextContent('2 tags on it work again only once written');
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(posted(fetchMock, '/keys/1/revoke')).toHaveLength(1));
  });

  it('retires a version nothing uses without asking', async () => {
    const user = userEvent.setup();
    const k = keysetFixture();
    k.versions[0] = { ...k.versions[0], tags: 0 } as (typeof k.versions)[number];
    const { fetchMock } = await openKeys([k], {
      '/api/v1/nfc/keysets/k1/keys/1/retire': () => json(k),
    });
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    await user.click(await screen.findByRole('button', { name: 'Retire version 1' }));
    await waitFor(() => expect(posted(fetchMock, '/keys/1/retire')).toHaveLength(1));
  });

  it('says how many tags a revoked version left, and shows no buttons on it', async () => {
    const user = userEvent.setup();
    const k = keysetFixture();
    k.versions[0] = {
      ...k.versions[0],
      state: 'retired',
      revokedAt: 1,
      tags: 3,
    } as (typeof k.versions)[number];
    await openKeys([k]);
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    const sheet = await screen.findByRole('dialog', { name: 'Staff badges' });
    expect(within(sheet).getByText('Version 1 · Revoked')).toBeInTheDocument();
    expect(within(sheet).getByText('3 need new keys')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /version 1/ })).toBeNull();
  });

  it('moves tags to another keyset and reports the count', async () => {
    const user = userEvent.setup();
    const other = keysetFixture({ id: 'k3', name: 'New badges', slug: 'newbdgs1' });
    const { fetchMock } = await openKeys([keysetFixture(), other], {
      '/api/v1/nfc/keysets/k1/reenrol': () =>
        json({ moved: 7, ownKey: 0, keyset: keysetFixture() }),
    });
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    await user.click(await screen.findByRole('button', { name: 'Move tags' }));
    const dialog = await screen.findByRole('dialog', { name: /Move tags from Staff badges/ });
    await user.click(within(dialog).getByRole('button', { name: 'Move tags' }));
    await waitFor(() => expect(posted(fetchMock, '/k1/reenrol')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/k1/reenrol')[0])).toEqual({ toKeysetId: 'k3' });
    expect(await screen.findByText('7 tags moved')).toBeInTheDocument();
  });

  it('disables a keyset only after its name is typed', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await openKeys(all(), {
      '/api/v1/nfc/keysets/k1/disable': () => json(keysetFixture()),
    });
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    const sheet = await screen.findByRole('dialog', { name: 'Staff badges' });
    await user.click(within(sheet).getByRole('button', { name: 'Disable' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable Staff badges?' });
    expect(confirm).toHaveTextContent('This cannot be undone.');
    const go = within(confirm).getByRole('button', { name: 'Disable' });
    expect(go).toBeDisabled();
    await user.type(within(confirm).getByRole('textbox'), 'Staff badges');
    await user.click(go);
    await waitFor(() => expect(posted(fetchMock, '/k1/disable')).toHaveLength(1));
  });

  it.each(AXE_MATRIX)(
    'has no axe violations at %i, %s',
    async (width, theme) => {
      const user = userEvent.setup();
      await openKeys(all());
      const table = await screen.findByRole('table', { name: 'Secure keysets' });
      expect(await axeAt(document.body, width, theme)).toEqual([]);
      await user.click(within(table).getByRole('button', { name: 'Staff badges' }));
      await screen.findByRole('dialog', { name: 'Staff badges' });
      expect(await axeAt(document.body, width, theme)).toEqual([]);
    },
    20_000,
  );
});
