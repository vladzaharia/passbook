import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '../../lib/mode.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { json, membershipFixture, renderApp, sessionFixture } from '../../lib/test-utils.tsx';
import * as memberPhotoFile from './member-photo-file.ts';
import * as png from './png.ts';
import {
  connectionDetail,
  ORG,
  passDetail,
  passSummary,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const reader = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  roles: ['read_only'],
  capabilities: ['org:read', 'passes:read', 'templates:read', 'integrations:read', 'scanning:read'],
});
const operator = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  roles: ['pass_operator'],
  capabilities: [
    'org:read',
    'passes:read',
    'passes:operate',
    'templates:read',
    'integrations:read',
  ],
});

afterEach(resetModeForTests);
afterEach(() => vi.restoreAllMocks());

function open(path: string, writable = false, over: Record<string, unknown> = {}) {
  const pass = passDetail({
    blockedUsers: [{ id: 'u9', name: 'Blocked member' }],
    ...over,
  });
  return renderApp(path, {
    session: 'admin',
    memberships: [writable ? operator : reader],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
      '/api/v1/passes/p1': () => json(pass),
      '/api/v1/holders/p1': () =>
        json({
          passId: 'p1',
          state: pass.holderState,
          email: pass.holderEmail,
          ownerUserId: pass.ownerUserId,
          ownerName: pass.ownerName,
          blockedUserIds: [],
          transfer: null,
          reissueRequired: false,
          updatedAt: 1,
        }),
      '/api/v1/passes/p1/assets': () => json({ items: [] }),
      '/api/v1/passes/p1/check-in': () =>
        json({
          passId: 'p1',
          orgId: ORG.id,
          rules: {},
          defaults: {},
          effective: {},
          updatedAt: null,
        }),
      '/api/v1/passes/p1/member-photo': () =>
        json({
          passId: 'p1',
          orgId: ORG.id,
          url: '/photo.png',
          includeInPass: true,
          walletSupported: true,
          updatedAt: null,
        }),
      '/api/v1/delivery': () => json({ items: pass.deliveries }),
      '/api/v1/bundles': () =>
        json({
          items: [
            {
              id: 'b1',
              orgId: ORG.id,
              mode: 'live',
              name: 'Trip bundle',
              url: 'https://wallet.test/b/tok',
              holderEmail: 'sam@example.com',
              passes: [{ id: 'p1', title: 'Sam Jones', status: 'active' }],
              createdAt: 1,
              linkRotatedAt: null,
            },
          ],
          nextCursor: null,
        }),
      '/api/v1/connections/c1': () => json(connectionDetail()),
    },
  });
}

describe('pass capability affordances', () => {
  it('keeps list selection and export for a reader but disables issue and bulk or row mutations', async () => {
    const user = userEvent.setup();
    await open('/admin/passes');
    expect(await screen.findByRole('link', { name: 'Sam Jones' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select Sam Jones' }));
    const selection = screen.getByRole('region', { name: 'Selection' });
    expect(within(selection).getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    for (const name of ['Send email', 'Share as bundle', 'Void', 'Remove from Wallet']) {
      expect(within(selection).getByRole('button', { name })).toBeDisabled();
    }
    await user.click(screen.getByRole('button', { name: 'Actions for Sam Jones' }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Download .pkpass' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    for (const name of ['Update devices', 'Void', 'Rotate link', 'Delete']) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('retains issue, edit and bulk actions for an operator', async () => {
    const user = userEvent.setup();
    await open('/admin/passes', true);
    expect(await screen.findByRole('link', { name: 'New pass' })).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Sam Jones' }));
    const selection = screen.getByRole('region', { name: 'Selection' });
    expect(within(selection).getByRole('button', { name: 'Share as bundle' })).toBeEnabled();
    expect(within(selection).getByRole('button', { name: 'Void' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Actions for Sam Jones' }));
    expect(screen.getByRole('menuitem', { name: 'Update devices' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows pass fields, public link and download but not editable header actions to a reader', async () => {
    const user = userEvent.setup();
    await open('/admin/passes/p1');
    expect(await screen.findByLabelText(/Member name/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Update devices' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open public page' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Download .pkpass' })).toHaveAttribute(
      'href',
      '/p/tok/pass.pkpass',
    );
    for (const name of ['Rotate link', 'Clear holder', 'Remove from Wallet', 'Delete']) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('keeps holder and check-in information visible without mutation controls', async () => {
    await open('/admin/passes/p1?tab=holder');
    expect(await screen.findByText('Blocked member')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow again' })).toBeDisabled();
    expect(await screen.findByLabelText('Member photo')).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Use template defaults' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  });

  it('allows an operator to manage the holder, photo and check-in rules', async () => {
    await open('/admin/passes/p1?tab=holder', true);
    // Change waits for the holder record to load.
    await screen.findByRole('button', { name: 'Change' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Allow again' })).toBeEnabled();
    await waitFor(() => expect(screen.getByLabelText('Member photo')).toBeEnabled());
    expect(await screen.findByRole('button', { name: 'Use template defaults' })).toBeEnabled();
  });

  it('shows delivery and bundle links without sending, rotation or deletion', async () => {
    const user = userEvent.setup();
    await open('/admin/passes/p1?tab=delivery');
    expect(await screen.findByText('Trip bundle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send to current holder' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Actions for Trip bundle' }));
    for (const name of ['Rotate link', 'Send email', 'Delete']) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('disables pass image replacement and connection changes for a reader', async () => {
    const user = userEvent.setup();
    await open('/admin/passes/p1?tab=images', false, { connectionId: 'c1', externalRef: 'r1' });
    expect(await screen.findByRole('button', { name: 'Replace Icon' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Connection' }));
    expect(await screen.findByRole('button', { name: 'Change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'More connection actions' }));
    expect(screen.getByRole('menuitem', { name: 'Unbind' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('does not upload a prepared image after operation permission is revoked', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const prepared = deferred.withResolvers<png.PngCheck>();
    const check = vi.spyOn(png, 'checkPng').mockReturnValue(prepared.promise);
    const user = userEvent.setup();
    const { queryClient, fetchMock } = await open('/admin/passes/p1?tab=images', true);
    const button = await screen.findByRole('button', { name: 'Replace Icon' });
    const input = button.closest('li')?.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Expected the image file input.');
    await user.upload(input, new File(['image'], 'icon.png', { type: 'image/png' }));
    expect(check).toHaveBeenCalledOnce();
    act(() => queryClient.setQueryData(membershipsQuery.queryKey, { items: [reader] }));
    await act(async () => {
      prepared.resolve({ ok: true, width: 58, height: 58 });
      await prepared.promise;
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          new URL(String(url), 'http://localhost').pathname.startsWith(
            '/api/v1/passes/p1/assets/',
          ) && init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('does not upload a prepared member photo after the principal changes', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const prepared = deferred.withResolvers<string>();
    const convert = vi.spyOn(memberPhotoFile, 'memberPhotoPng').mockReturnValue(prepared.promise);
    const user = userEvent.setup();
    const { queryClient, fetchMock } = await open('/admin/passes/p1?tab=holder', true);
    const photo = await screen.findByLabelText('Member photo');
    await waitFor(() => expect(photo).toBeEnabled());
    await user.upload(photo, new File(['image'], 'member.png', { type: 'image/png' }));
    expect(convert).toHaveBeenCalledOnce();
    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
    act(() => {
      const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
      queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [{ ...operator, userId: 'u2' }],
      });
    });
    await act(async () => {
      prepared.resolve('encoded-photo');
      await prepared.promise;
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          new URL(String(url), 'http://localhost').pathname === '/api/v1/passes/p1/member-photo' &&
          init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('closes an already open mutation dialog when operation permission is revoked', async () => {
    const user = userEvent.setup();
    const { queryClient, fetchMock } = await open('/admin/passes/p1', true);
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    expect(await screen.findByRole('alertdialog', { name: 'Void pass?' })).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(membershipsQuery.queryKey, { items: [reader] });
    });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Void pass?' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Void' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
