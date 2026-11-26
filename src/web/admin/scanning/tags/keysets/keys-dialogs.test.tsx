import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { AXE_MATRIX, axeAt } from '../../../tags/test-fixtures.tsx';
import { bodyOf, keysetFixture, openKeys, posted, supplierFixture } from './test-fixtures.tsx';

afterEach(() => vi.restoreAllMocks());

const META = 'c3'.repeat(16);
const FILE = 'd4'.repeat(16);
const made = (over: object = {}) => ({ ...keysetFixture(), keys: null, ...over });

async function openNew(extra: Parameters<typeof openKeys>[1] = {}) {
  const user = userEvent.setup();
  const rendered = await openKeys([], extra);
  await user.click(await screen.findByRole('button', { name: 'New keyset' }));
  const dialog = await screen.findByRole('dialog', { name: 'New keyset' });
  return { user, dialog, ...rendered };
}

type User = ReturnType<typeof userEvent.setup>;
async function next(user: User, dialog: HTMLElement, heading: string) {
  await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  await within(dialog).findByRole('heading', { name: heading });
}
const create = (user: User, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'Create keyset' }));

describe('New keyset', () => {
  it('generates keys, shows them once with the tag settings, and drops them when done', async () => {
    const { user, dialog, fetchMock } = await openNew({
      '/api/v1/nfc/keysets': (_u, init) =>
        init?.method === 'POST'
          ? json(made({ keys: { metaKey: META, fileKey: FILE } }), 201)
          : json({ items: [], nextCursor: null }),
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Staff badges');
    // Generate has no Keys step: Review follows.
    await next(user, dialog, 'Check and create');
    expect(within(dialog).getByText('The keys are shown once, after you create it.')).toBeVisible();
    await create(user, dialog);
    await waitFor(() => expect(posted(fetchMock, '/api/v1/nfc/keysets')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/api/v1/nfc/keysets')[0])).toEqual({
      name: 'Staff badges',
      generate: true,
      diversify: true,
    });
    const keys = await screen.findByRole('dialog', { name: 'Keys of Staff badges' });
    expect(keys).toHaveTextContent('Copy the secret now');
    expect(within(keys).getByRole('region', { name: 'Tag settings' })).toHaveTextContent(
      '/t/abcd1234',
    );
    // Masked until shown; closed only after the admin says they saved them.
    expect(keys).not.toHaveTextContent(META);
    await user.click(within(keys).getByRole('button', { name: 'Show Meta key' }));
    expect(within(keys).getByRole('status', { name: 'Meta key' })).toHaveTextContent(
      META.slice(0, 12),
    );
    const done = within(keys).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(keys).getByRole('checkbox', { name: 'I saved the keys' }));
    await user.click(done);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keys of Staff badges' })).toBeNull(),
    );
    expect(document.body.textContent).not.toContain(META);
  });

  it('takes supplier keys and says they are stored, not shown', async () => {
    const { user, dialog, fetchMock } = await openNew({
      '/api/v1/nfc/keysets': (_u, init) =>
        init?.method === 'POST' ? json(made(), 201) : json({ items: [], nextCursor: null }),
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Supplier');
    await user.click(within(dialog).getByRole('radio', { name: /Enter supplier keys/ }));
    await next(user, dialog, 'Enter the keys');
    await user.type(within(dialog).getByRole('textbox', { name: /Meta key/ }), META);
    await user.type(within(dialog).getByRole('textbox', { name: /File key/ }), FILE);
    await next(user, dialog, 'Check and create');
    // The review says the keys were entered, never what they are.
    expect(dialog).not.toHaveTextContent(META);
    await create(user, dialog);
    await waitFor(() => expect(posted(fetchMock, '/api/v1/nfc/keysets')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/api/v1/nfc/keysets')[0])).toEqual({
      name: 'Supplier',
      diversify: true,
      metaKey: META,
      fileKey: FILE,
    });
    expect(
      await screen.findByText('Your keys are stored. They are not shown again.'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FILE);
  });

  it('asks for the meta key only when each tag has its own key', async () => {
    const { user, dialog, fetchMock } = await openNew({
      '/api/v1/nfc/keysets': (_u, init) =>
        init?.method === 'POST'
          ? json(made({ perTag: true }), 201)
          : json({ items: [], nextCursor: null }),
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Supplier tags');
    await user.click(within(dialog).getByRole('radio', { name: /Imported per tag/ }));
    await next(user, dialog, 'Enter the keys');
    expect(within(dialog).queryByRole('textbox', { name: /File key/ })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /Meta key/ }), META);
    await next(user, dialog, 'Check and create');
    await create(user, dialog);
    await waitFor(() => expect(posted(fetchMock, '/api/v1/nfc/keysets')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/api/v1/nfc/keysets')[0])).toEqual({
      name: 'Supplier tags',
      perTag: true,
      metaKey: META,
    });
  });

  it('refuses a key that is not 32 hex digits before sending anything', async () => {
    const { user, dialog, fetchMock } = await openNew();
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'X');
    await user.click(within(dialog).getByRole('radio', { name: /Imported per tag/ }));
    await next(user, dialog, 'Enter the keys');
    await user.type(within(dialog).getByRole('textbox', { name: /Meta key/ }), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText('A key is 32 hex digits.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Check and create' })).toBeNull();
    expect(posted(fetchMock, '/api/v1/nfc/keysets')).toHaveLength(0);
  });

  it('shows what the server refused and stays open', async () => {
    const { user, dialog } = await openNew({
      '/api/v1/nfc/keysets': (_u, init) =>
        init?.method === 'POST'
          ? json(
              {
                type: 'about:blank#KEYSET_LIMIT',
                title: 'x',
                status: 409,
                code: 'KEYSET_LIMIT',
                detail: '4 keysets are in use. Disable one first.',
              },
              409,
            )
          : json({ items: [], nextCursor: null }),
    });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Fifth');
    await next(user, dialog, 'Check and create');
    await create(user, dialog);
    expect(await within(dialog).findByText(/4 keysets are in use/)).toBeInTheDocument();
  });

  it.each(AXE_MATRIX)(
    'has no axe violations at %i, %s',
    async (width, theme) => {
      const { user, dialog } = await openNew();
      expect(await axeAt(document.body, width, theme)).toEqual([]);
      await user.click(within(dialog).getByRole('radio', { name: /Enter supplier keys/ }));
      expect(await axeAt(document.body, width, theme)).toEqual([]);
      await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'X');
      await next(user, dialog, 'Enter the keys');
      expect(await axeAt(document.body, width, theme)).toEqual([]);
    },
    20_000,
  );
});

describe('Rotate keys', () => {
  it('sends the meta key only for imported tags, and generated keys otherwise', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await openKeys([supplierFixture()], {
      '/api/v1/nfc/keysets/k2/rotate': () => json(made({ id: 'k2', perTag: true })),
    });
    await user.click(await screen.findByRole('button', { name: 'Supplier tags' }));
    await user.click(await screen.findByRole('button', { name: 'Rotate keys' }));
    const dialog = await screen.findByRole('dialog', { name: /Rotate keys of Supplier tags/ });
    expect(within(dialog).queryByRole('textbox', { name: /File key/ })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /Meta key/ }), META);
    await user.click(within(dialog).getByRole('button', { name: 'Rotate keys' }));
    await waitFor(() => expect(posted(fetchMock, '/k2/rotate')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/k2/rotate')[0])).toEqual({ metaKey: META });
  });

  it('offers generate or enter on a keyset of derived keys', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await openKeys(
      [
        keysetFixture({
          versions: [
            { version: 1, state: 'active', createdAt: 1, stateAt: null, revokedAt: null, tags: 0 },
          ],
        }),
      ],
      {
        '/api/v1/nfc/keysets/k1/rotate': () =>
          json(made({ keys: { metaKey: META, fileKey: FILE } })),
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Staff badges' }));
    await user.click(await screen.findByRole('button', { name: 'Rotate keys' }));
    const dialog = await screen.findByRole('dialog', { name: /Rotate keys of Staff badges/ });
    await user.click(within(dialog).getByRole('button', { name: 'Rotate keys' }));
    await waitFor(() => expect(posted(fetchMock, '/k1/rotate')).toHaveLength(1));
    expect(bodyOf(posted(fetchMock, '/k1/rotate')[0])).toEqual({ generate: true });
    expect(await screen.findByRole('dialog', { name: 'Keys of Staff badges' })).toBeInTheDocument();
  });
});
