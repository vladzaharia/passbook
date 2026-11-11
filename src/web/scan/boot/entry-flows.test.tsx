import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { ApiError } from '../../lib/errors.ts';
import { json, sessionFixture as platformSession, stubFetch } from '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { AdminStart } from './admin-start.tsx';
import { sessionFixture } from './session.test-support.ts';
import { StaffStart } from './staff-start.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});
const membership = {
  id: 'm1',
  orgId: 'o1',
  orgName: 'Northwind',
  orgSlug: 'northwind',
  userId: 'u1',
  roles: ['org_admin'],
  capabilities: ['scanning:read', 'scanning:manage'],
  createdAt: 1,
  revokedAt: null,
};
function wrapper(children: React.ReactNode) {
  return (
    <CoreProviders
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      {children}
    </CoreProviders>
  );
}
function adminStart(creating: boolean) {
  const joined = { orgId: 'o1', setupId: 'device-1', mode: 'live', timeZone: 'UTC' };
  const onScope = vi.fn();
  const bodies: { path: string; body: unknown; csrf?: string }[] = [];
  stubFetch({
    '/api/v1/session': () => json(platformSession('user')),
    '/api/v1/orgs/memberships/me': () => json({ items: [membership] }),
    '/api/v1/scanning-sessions': (url, init) => {
      if (init?.method === 'POST') {
        bodies.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        return json(managedSession, 201);
      }
      return json({ items: creating ? [] : [managedSession], nextCursor: null });
    },
    '/api/v1/scanning-sessions/join': (url, init) => {
      bodies.push({
        path: url.pathname,
        body: JSON.parse(String(init?.body)),
        csrf: new Headers(init?.headers).get('x-csrf-token') ?? undefined,
      });
      return json(joined);
    },
  });
  render(wrapper(<AdminStart userId="u1" onScope={onScope} />));
  return { onScope, bodies, joined };
}
describe('scanner entry flows', () => {
  it('joins an existing managed session with this browser’s device key and platform CSRF', async () => {
    const s = adminStart(false);
    const user = userEvent.setup();
    const org = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(org).toBeEnabled());
    await user.click(org);
    await user.click(await screen.findByRole('option', { name: 'Northwind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(await screen.findByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(s.joined));
    expect(s.bodies).toMatchObject([
      {
        path: '/api/v1/scanning-sessions/join',
        body: { sessionId: managedSession.id, deviceKey: expect.any(String) },
      },
    ]);
    expect(s.bodies[0]?.csrf).toBeTruthy();
  });
  it('creates the organization’s first session before joining it', async () => {
    const s = adminStart(true);
    const user = userEvent.setup();
    const org = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(org).toBeEnabled());
    await user.click(org);
    await user.click(await screen.findByRole('option', { name: 'Northwind' }));
    const name = await screen.findByRole('textbox', { name: 'New session name' });
    await user.clear(name);
    await user.type(name, 'Member entrance');
    await user.click(screen.getByRole('button', { name: 'Create and join' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(s.joined));
    expect(s.bodies.map((b) => b.path)).toEqual([
      '/api/v1/scanning-sessions',
      '/api/v1/scanning-sessions/join',
    ]);
    expect(s.bodies[0]?.body).toMatchObject({ orgId: 'o1', name: 'Member entrance' });
  });
  it('signs staff in with a PIN and leaves failed sign-in retryable', async () => {
    const signIn = vi
      .fn<ScanApi['staffSignIn']>()
      .mockRejectedValueOnce(
        new ApiError({ status: 422, code: 'STAFF_PIN_INVALID', detail: 'Wrong PIN.' }),
      )
      .mockResolvedValue(sessionFixture());
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(
      wrapper(
        <StaffStart
          session={sessionFixture({
            state: 'staff_required',
            staffList: [{ id: 'staff-1', name: 'Door staff', role: 'door' }],
          })}
          api={{ staffSignIn: signIn } as unknown as ScanApi}
          refetch={refetch}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Staff member' }));
    await user.click(screen.getByRole('option', { name: 'Door staff' }));
    await user.type(screen.getByLabelText('PIN'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong PIN.')).toBeInTheDocument();
    expect(screen.getByLabelText('PIN')).toHaveValue('');
    await user.type(screen.getByLabelText('PIN'), '654321');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(signIn).toHaveBeenLastCalledWith({ staffId: 'staff-1', pin: '654321' });
  });
  it('searches the roster by name when it was cut, and signs the match in', async () => {
    const signIn = vi.fn<ScanApi['staffSignIn']>().mockResolvedValue(sessionFixture());
    const search = vi
      .fn<ScanApi['staffSearch']>()
      .mockResolvedValue({ items: [{ id: 'staff-9', name: 'Zed Last', role: 'door' }] });
    render(
      wrapper(
        <StaffStart
          session={sessionFixture({
            state: 'staff_required',
            staffTruncated: true,
            staffList: [{ id: 'staff-1', name: 'Door staff', role: 'door' }],
          })}
          api={{ staffSignIn: signIn, staffSearch: search } as unknown as ScanApi}
          refetch={vi.fn().mockResolvedValue(undefined)}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Find your name'), 'zed');
    await waitFor(() => expect(search).toHaveBeenCalledWith('zed'));
    await user.click(screen.getByRole('combobox', { name: 'Staff member' }));
    await user.click(await screen.findByRole('option', { name: 'Zed Last' }));
    await user.type(screen.getByLabelText('PIN'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ staffId: 'staff-9', pin: '123456' }));
  });
  it('shows no search field when the roster is whole', () => {
    render(
      wrapper(
        <StaffStart
          session={sessionFixture({
            state: 'staff_required',
            staffList: [{ id: 'staff-1', name: 'Door staff', role: 'door' }],
          })}
          api={{} as unknown as ScanApi}
          refetch={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByLabelText('Find your name')).not.toBeInTheDocument();
  });
});
