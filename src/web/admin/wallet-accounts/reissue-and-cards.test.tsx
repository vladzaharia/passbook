import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { walletReissue } from '@/shared/operations/kinds/wallet-reissue.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { fixtureOperation } from '@/web/ui/operation/fixtures.test-support.ts';
import {
  credential,
  enrolment,
  renderOrgAccounts,
  walletRelease,
} from './wallet-accounts-test-fixtures.ts';

const MANAGE: OrgCapability[] = [
  'org:read',
  'integrations:read',
  'integrations:manage',
  'passes:operate',
];
const READ: OrgCapability[] = ['org:read', 'integrations:read'];
const member = (capabilities: OrgCapability[]) =>
  membershipFixture('o1', { orgName: 'North', capabilities });

beforeEach(() => {
  resetModeForTests();
  setMode('test');
});
afterEach(() => resetModeForTests());

const on = (provider: 'google' | 'samsung') =>
  enrolment({
    provider,
    state: 'on',
    source: 'platform',
    prerequisites: { check: true, roundTrip: null },
  });
const orgHandlers = (items = [on('google'), on('samsung')]) => ({
  '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
  '/api/v1/orgs/o1/wallet-enrolments': () => json({ items, nextCursor: null }),
  '/api/v1/orgs/o1/wallet-credentials': () => json({ items: [], nextCursor: null }),
  '/api/v1/operations': () => json({ items: [], nextCursor: null }),
});

describe('wallet reissue', () => {
  it('sends every active copy again after a confirmation, and says how many', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    const { container } = await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers(),
        '/api/v1/wallet-providers/reissue': (_u, init) => {
          posts.push(JSON.parse(String(init?.body)));
          return json({ reissueId: 'r1', instances: 3, operationId: 'op-1' }, 202);
        },
        '/api/v1/operations/op-1': () => {
          return json(
            fixtureOperation(
              {
                kind: walletReissue.kind,
                title: walletReissue.title,
                doneTitle: walletReissue.doneTitle,
                failTitle: walletReissue.failTitle,
                steps: walletReissue.steps.map((s) => ({
                  key: s.key,
                  label: s.label,
                  active: s.active,
                })),
              },
              { status: 'running', at: 'copies', counts: { done: 1, total: 3 }, id: 'op-1' },
            ),
          );
        },
      },
    });
    const samsung = await screen.findByRole('region', { name: 'Samsung Wallet' });
    await user.click(within(samsung).getByRole('button', { name: 'Update passes' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Update Samsung Wallet passes?')).toBeInTheDocument();
    expect(posts).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(posts).toEqual([{ orgId: 'o1', provider: 'samsung' }]));
    // The operation shows the run, with its count, instead of a toast and then silence.
    expect(await screen.findByText('Updating passes · 1 of 3')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says so when there is nothing to send yet', async () => {
    const user = userEvent.setup();
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers(),
        '/api/v1/wallet-providers/reissue': () =>
          json({ reissueId: 'r1', instances: 0, operationId: null }, 202),
      },
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Update passes' }));
    await user.click(
      await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Update' }),
    );
    expect(await screen.findByText('Nothing to update yet')).toBeInTheDocument();
  });

  it('is offered only to those who manage accounts, and only while the wallet is on', async () => {
    await renderOrgAccounts({
      memberships: [member(READ)],
      handlers: orgHandlers(),
    });
    await screen.findByRole('region', { name: 'Google Wallet' });
    expect(screen.queryByRole('button', { name: 'Update passes' })).toBeNull();
  });

  it('is not offered to a member who manages accounts but cannot operate passes', async () => {
    await renderOrgAccounts({
      memberships: [member(['org:read', 'integrations:read', 'integrations:manage'])],
      handlers: orgHandlers(),
    });
    await screen.findByRole('region', { name: 'Google Wallet' });
    expect(screen.queryByRole('button', { name: 'Update passes' })).toBeNull();
  });

  it('is not offered while the wallet is off', async () => {
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers([
        enrolment({ state: 'off', source: 'org', prerequisites: { check: true, roundTrip: null } }),
        enrolment({ provider: 'samsung' }),
      ]),
    });
    await screen.findByRole('region', { name: 'Google Wallet' });
    expect(screen.queryByRole('button', { name: 'Update passes' })).toBeNull();
  });
});

describe('Samsung cards per type on the platform tab', () => {
  const platform = (cardTypes: string[]) =>
    credential({ scope: 'platform', orgId: null, mode: 'live', provider: 'samsung', cardTypes });
  const handlers = (cardTypes: string[], saved: unknown[] = []) => ({
    '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/platform/wallet-credentials': () =>
      json({ items: [platform(cardTypes)], nextCursor: null, release: walletRelease() }),
    '/api/v1/platform/wallet-enrolments': () => json({ items: [], nextCursor: null }),
    '/api/v1/platform/wallet-credentials/c1/cards': (_u: URL, init?: RequestInit) => {
      saved.push(JSON.parse(String(init?.body)));
      return json(platform([...cardTypes, 'ticket']));
    },
  });

  it('shows which types have a card and sets one more without the secrets', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    const { container } = await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers(['loyalty'], saved),
    });
    await user.click(await screen.findByRole('tab', { name: 'Samsung' }));
    const list = await screen.findByRole('list', { name: 'Samsung cards' });
    expect(within(list).getByText('Card set')).toBeInTheDocument();
    for (const set of within(list).getAllByRole('button', { name: 'Set' }))
      expect(set).toBeDisabled();
    await user.type(within(list).getAllByLabelText(/Card ID for/)[0] as HTMLElement, 'bad id!');
    expect(await within(list).findByText(/Use 1–32 letters/)).toBeInTheDocument();
    await user.clear(within(list).getAllByLabelText(/Card ID for/)[0] as HTMLElement);
    await user.type(within(list).getAllByLabelText(/Card ID for/)[0] as HTMLElement, 'ticketcard');
    await user.click(within(list).getAllByRole('button', { name: 'Set' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Set the ticket card to ticketcard?')).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be changed/)).toBeInTheDocument();
    expect(saved).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Set card' }));
    await waitFor(() =>
      expect(saved).toEqual([{ type: 'ticket', cardId: 'ticketcard', expectedRevision: 1 }]),
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('is not shown on the Google tab or without a credential', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        ...handlers([]),
        '/api/v1/platform/wallet-credentials': () =>
          json({ items: [], nextCursor: null, release: walletRelease() }),
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Samsung' }));
    await screen.findAllByText('No credentials');
    expect(screen.queryByRole('list', { name: 'Samsung cards' })).toBeNull();
  });
});
