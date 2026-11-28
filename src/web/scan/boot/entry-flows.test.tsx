import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { ApiError } from '../../lib/errors.ts';
import { json, sessionFixture as platformSession, stubFetch } from '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { AdminStart } from './admin-start.tsx';
import { issuedPins, needsPinReset } from './pin-reset-state.ts';
import { sessionFixture } from './session.test-support.ts';
import { StaffPinReset } from './staff-pin-reset.tsx';
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
    '/api/v1/settings': () => json({ items: [] }),
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
    expect(s.bodies[0]?.body).toMatchObject({
      orgId: 'o1',
      name: 'Member entrance',
      timeZone: 'America/Los_Angeles',
    });
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
    await user.click(screen.getByRole('button', { name: 'Not you? Pick your name' }));
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
    const search = vi.fn<ScanApi['staffSearch']>().mockResolvedValue({
      items: [{ id: 'staff-9', name: 'Zed Last', role: 'door' }],
      nextCursor: null,
    });
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
    await user.click(screen.getByRole('button', { name: 'Not you? Pick your name' }));
    await user.type(screen.getByLabelText('Find your name'), 'zed');
    await waitFor(() => expect(search).toHaveBeenCalledWith('zed'));
    await user.click(screen.getByRole('combobox', { name: 'Staff member' }));
    await user.click(await screen.findByRole('option', { name: 'Zed Last' }));
    await user.type(screen.getByLabelText('PIN'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ staffId: 'staff-9', pin: '123456' }));
  });
  it('opens on the keypad and signs in with the PIN alone', async () => {
    const signIn = vi.fn<ScanApi['staffSignIn']>().mockResolvedValue(sessionFixture());
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(
      wrapper(
        <StaffStart
          session={sessionFixture({ state: 'staff_required' })}
          api={{ staffSignIn: signIn } as unknown as ScanApi}
          refetch={refetch}
        />,
      ),
    );
    const user = userEvent.setup();
    expect(screen.queryByRole('combobox', { name: 'Staff member' })).not.toBeInTheDocument();
    for (const digit of '246801') await user.click(screen.getByRole('button', { name: digit }));
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(signIn).toHaveBeenCalledWith({ pin: '246801' });
  });
  it('shows a wrong PIN and lets the keypad try again', async () => {
    const signIn = vi
      .fn<ScanApi['staffSignIn']>()
      .mockRejectedValueOnce(
        new ApiError({ status: 400, code: 'PIN_INVALID', detail: 'Wrong PIN. 4 tries left.' }),
      )
      .mockResolvedValue(sessionFixture());
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(
      wrapper(
        <StaffStart
          session={sessionFixture({ state: 'staff_required' })}
          api={{ staffSignIn: signIn } as unknown as ScanApi}
          refetch={refetch}
        />,
      ),
    );
    const user = userEvent.setup();
    for (const digit of '000000') await user.click(screen.getByRole('button', { name: digit }));
    expect(await screen.findByText('Wrong PIN. 4 tries left.')).toBeInTheDocument();
    for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(signIn).toHaveBeenLastCalledWith({ pin: '123456' });
  });
  it('turns the keypad off for the server wait after too many wrong PINs, then back on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const signIn = vi
        .fn<ScanApi['staffSignIn']>()
        .mockRejectedValueOnce(
          new ApiError({
            status: 429,
            code: 'RATE_LIMITED',
            detail: 'Too many wrong PINs. Try again later.',
            retryAfter: 90,
          }),
        )
        .mockResolvedValue(sessionFixture());
      const refetch = vi.fn().mockResolvedValue(undefined);
      render(
        wrapper(
          <StaffStart
            session={sessionFixture({ state: 'staff_required' })}
            api={{ staffSignIn: signIn } as unknown as ScanApi}
            refetch={refetch}
          />,
        ),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      for (const digit of '000000') await user.click(screen.getByRole('button', { name: digit }));
      expect(await screen.findByText(/Too many wrong PINs/)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-disabled', 'true'),
      );
      expect(signIn).toHaveBeenCalledTimes(1);

      await user.keyboard('123456');
      for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
      expect(signIn).toHaveBeenCalledTimes(1);

      // The server said 90 s: 60 s is not enough, 90 s is.
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-disabled', 'true');
      act(() => vi.advanceTimersByTime(30_000));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '1' })).not.toHaveAttribute(
          'aria-disabled',
          'true',
        ),
      );
      for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
      await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
      expect(signIn).toHaveBeenCalledTimes(2);
      expect(signIn).toHaveBeenLastCalledWith({ pin: '123456' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('falls back to a name when PIN-only is paused, and can go back to the keypad', async () => {
    const signIn = vi
      .fn<ScanApi['staffSignIn']>()
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'STAFF_NAME_REQUIRED',
          detail: 'Pick your name, then enter your PIN.',
        }),
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
    for (const digit of '112358') await user.click(screen.getByRole('button', { name: digit }));
    expect(await screen.findByText(/Pick your name, then enter your PIN/)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Staff member' }));
    await user.click(screen.getByRole('option', { name: 'Door staff' }));
    await user.type(screen.getByLabelText('PIN'), '112358');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(signIn).toHaveBeenLastCalledWith({ staffId: 'staff-1', pin: '112358' });
    await user.click(screen.getByRole('button', { name: 'Use PIN only' }));
    expect(screen.getByTestId('scan-keypad')).toBeInTheDocument();
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

describe('a shared PIN: getting a new one', () => {
  afterEach(() => issuedPins.clear());
  const session = () =>
    sessionFixture({
      staff: { id: 'staff-r', name: 'Dana', role: 'door', pinResetRequired: true },
    });
  const reset = (
    newPin: ScanApi['staffNewPin'],
    refetch = vi.fn().mockResolvedValue(undefined),
    staffSignOut: ScanApi['staffSignOut'] = vi.fn().mockResolvedValue(sessionFixture()),
  ) => {
    render(
      wrapper(
        <StaffPinReset
          session={session()}
          api={{ staffNewPin: newPin, staffSignOut }}
          refetch={refetch}
        />,
      ),
    );
    return { refetch, user: userEvent.setup() };
  };
  const issue = () =>
    vi.fn<ScanApi['staffNewPin']>().mockResolvedValue({ pin: '497205', session: sessionFixture() });
  const key = async (user: ReturnType<typeof userEvent.setup>, digits: string) => {
    for (const digit of digits) await user.click(screen.getByRole('button', { name: digit }));
  };
  it('shows the server PIN once, then asks it back before going on', async () => {
    const newPin = issue();
    const { user, refetch } = reset(newPin);
    await user.click(screen.getByRole('button', { name: 'Get new PIN' }));
    expect(await screen.findByTestId('new-pin')).toHaveTextContent('497205');
    expect(screen.getByText('Remember this PIN')).toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'I remember it' }));
    expect(screen.queryByTestId('new-pin')).not.toBeInTheDocument();
    await key(user, '497205');
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    expect(newPin).toHaveBeenCalledOnce();
    expect(needsPinReset(session())).toBe(true);
  });
  it('says when the typed PIN is not it, and can show it again', async () => {
    const { user, refetch } = reset(issue());
    await user.click(screen.getByRole('button', { name: 'Get new PIN' }));
    await user.click(await screen.findByRole('button', { name: 'I remember it' }));
    await key(user, '497206');
    expect(await screen.findByText("That's not it. Try again.")).toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Show it again' }));
    expect(await screen.findByTestId('new-pin')).toHaveTextContent('497205');
  });
  it('shows a refusal and offers the button again', async () => {
    const newPin = vi
      .fn<ScanApi['staffNewPin']>()
      .mockRejectedValue(
        new ApiError({ status: 429, code: 'RATE_LIMITED', detail: 'Too many requests.' }),
      );
    const { user } = reset(newPin);
    await user.click(screen.getByRole('button', { name: 'Get new PIN' }));
    expect(await screen.findByText('Too many requests.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get new PIN' })).toBeInTheDocument();
  });
  it('lets the person sign out instead, and drops an unconfirmed PIN from memory', async () => {
    const out = vi.fn<ScanApi['staffSignOut']>().mockResolvedValue(sessionFixture());
    const { user, refetch } = reset(issue(), undefined, out);
    await user.click(screen.getByRole('button', { name: 'Get new PIN' }));
    await screen.findByTestId('new-pin');
    expect(issuedPins.size).toBe(1);
    // The session no longer has this person: the PIN is forgotten.
    expect(needsPinReset(sessionFixture())).toBe(false);
    expect(issuedPins.size).toBe(0);
    expect(out).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });
});
