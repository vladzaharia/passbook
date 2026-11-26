import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { passKeys } from '../passes/api.ts';
import {
  AXE_MATRIX,
  axeAt,
  calls,
  page,
  personTag,
  renderTags,
  scannerFixture,
  tagFixture,
} from './test-fixtures.tsx';
import { UserTagsCard } from './user-tags-card.tsx';

const passes = [
  { id: 'p1', title: 'Gym pass', orgName: 'Northwind', status: 'active' },
  { id: 'p2', title: 'Pool pass', orgName: 'Northwind', status: 'active' },
  { id: 'p3', title: 'Old', orgName: 'Northwind', status: 'voided' },
];
const card = (list = passes) => (
  <UserTagsCard userId="u9" name="Maya Okafor" passes={list} passCount={3} />
);
const northwind = { orgId: 'o1', orgName: 'Northwind' };
const handlers = {
  '/api/v1/nfc/users/u9/tags': () =>
    page([
      { ...personTag(), ...northwind },
      { ...tagFixture(), ...northwind },
    ]),
  '/api/v1/nfc/scanners': () => page([scannerFixture()]),
};

afterEach(() => vi.restoreAllMocks());

describe('User tags card', () => {
  it('groups person-wide tags, then the ones on a single pass, once each', async () => {
    const { fetchMock } = renderTags(card(), handlers);
    const lists = await screen.findAllByRole('list');
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Key card')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: TAG_COPY.userGroup })).toBeInTheDocument();
    const single = screen.getByRole('list', { name: TAG_COPY.userGroup });
    expect(within(single).getByText('Blue fob')).toBeInTheDocument();
    expect(within(single).getByText('Northwind')).toBeInTheDocument();
    expect(calls(fetchMock, 'GET', '/users/u9/tags')).toHaveLength(1);
  });

  it('assigns person-wide through the pass of the only organization', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderTags(card(), handlers);
    queryClient.setQueryData(passKeys.detail('p1'), {
      id: 'p1',
      orgId: 'o1',
      status: 'active',
      ownerUserId: 'u9',
    });
    await user.click(await screen.findByRole('button', { name: TAG_COPY.assign }));
    const dialog = await screen.findByRole('dialog', { name: TAG_COPY.dialog.title });
    // The choice is fixed to the person: there is no Works with group.
    expect(within(dialog).queryByRole('radio', { name: /This pass/ })).toBeNull();
  });

  it('asks for the organization first when the person has passes in several', async () => {
    const user = userEvent.setup();
    renderTags(card([...passes, { id: 'p9', title: 'Desk', orgName: 'Acme', status: 'active' }]), {
      ...handlers,
      '/api/v1/nfc/passes/p9/tags': () => page([]),
    });
    await user.click(await screen.findByRole('button', { name: TAG_COPY.assign }));
    expect(
      await screen.findByRole('heading', { name: 'Pick the organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Organization/ })).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Pick an organization.')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    renderTags(card([passes[0] as (typeof passes)[number]]), {
      '/api/v1/nfc/users/u9/tags': () => page([]),
    });
    expect(await screen.findByText(TAG_COPY.empty)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: TAG_COPY.assign })).toBeEnabled(),
    );
  });

  it.each(AXE_MATRIX)('has no axe violations at %i, %s', async (width, theme) => {
    const { container } = renderTags(card(), handlers);
    await screen.findByRole('list', { name: TAG_COPY.userGroup });
    expect(await axeAt(container, width, theme)).toEqual([]);
  });
});
