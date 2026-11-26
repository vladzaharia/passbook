import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationPreview } from '@/shared/contracts/invitations.ts';
import { INVITATION_COPY as copy } from '@/shared/copy/invitation.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';

const goTo = vi.hoisted(() => vi.fn());
vi.mock('../portal/goto.ts', () => ({ goTo }));

const SECRET = `m_${'a'.repeat(43)}`;
const preview = (over: Partial<InvitationPreview> = {}): InvitationPreview => ({
  kind: 'member',
  orgName: 'Agency',
  roles: ['pass_operator'],
  developer: false,
  email: 'a•••@agency.test',
  expiresAt: 4_000_000_000_000,
  polaris: true,
  ...over,
});
const previewed = (body: InvitationPreview | Response) => ({
  '/api/v1/invitations/preview': () => (body instanceof Response ? body : json(body)),
});
const open = (secret = SECRET) => history.replaceState(null, '', `/invite#${secret}`);

beforeEach(() => {
  sessionStorage.clear();
  window.turnstile = {
    render: vi.fn((_el, options: Record<string, unknown>) => {
      (options.callback as (token: string) => void)('ok');
      return 'w1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.turnstile = undefined;
  history.replaceState(null, '', '/');
  goTo.mockReset();
});

describe('the invitation page', () => {
  it('names the invitation, hides the secret from the address bar and offers the Polaris ID paths', async () => {
    open();
    await renderApp('/invite', { session: 'anon', handlers: previewed(preview()) });
    expect(await screen.findByRole('heading', { name: 'Join Agency' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('passbook.invite')).toBe(SECRET);
    expect(screen.getByText('As a pass operator.')).toBeInTheDocument();
    expect(screen.getByText('For a•••@agency.test.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.create })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.have })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.signIn })).toHaveAttribute(
      'href',
      '/auth/oidc/start?next=%2Finvite',
    );
  });

  it('names a developer invitation with the roles it joins', async () => {
    open(`d_${'b'.repeat(43)}`);
    await renderApp('/invite', {
      session: 'anon',
      handlers: previewed(preview({ kind: 'developer', developer: true, roles: ['read_only'] })),
    });
    expect(await screen.findByRole('heading', { name: 'Build for Agency' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Developer access with your own sandbox\. You also join as a read-only member\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows only the sign-in link while Polaris ID cannot make or find accounts', async () => {
    open();
    await renderApp('/invite', {
      session: 'anon',
      handlers: previewed(preview({ polaris: false })),
    });
    await screen.findByRole('heading', { name: 'Join Agency' });
    expect(screen.queryByRole('button', { name: copy.create })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.have })).toBeNull();
    expect(screen.getByRole('link', { name: copy.signIn })).toBeInTheDocument();
  });

  it('says so for a link that is bad, unknown or ended, and forgets it', async () => {
    open('nope');
    await renderApp('/invite', { session: 'anon' });
    expect(await screen.findByRole('heading', { name: copy.invalid })).toBeInTheDocument();
    sessionStorage.clear();
    open();
    await renderApp('/invite', {
      session: 'anon',
      handlers: previewed(
        problem(400, 'INVITATION_INVALID', 'This invitation is invalid or expired.'),
      ),
    });
    expect(await screen.findAllByRole('heading', { name: copy.invalid })).not.toHaveLength(0);
  });

  it('creates a Polaris ID: posts the setup with the Turnstile token and opens the link in its own tab', async () => {
    open();
    const setup = vi.fn(() => json({ setupUrl: 'https://id.test/st/abc', expiresAt: 1 }));
    const tab = { opener: 'x', location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { fetchMock } = await renderApp('/invite', {
      session: 'anon',
      handlers: { ...previewed(preview()), '/api/v1/invitations/setup': setup },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.create }));
    expect(await screen.findByText(copy.afterSetup)).toBeInTheDocument();
    expect(tab.location.href).toBe('https://id.test/st/abc');
    expect(tab.opener).toBeNull();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/setup'));
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
      token: SECRET,
      turnstileToken: 'ok',
    });
    expect(screen.getByRole('link', { name: copy.signIn })).toBeInTheDocument();
  });

  it('claims the existing account and goes on to sign in; an address with none says so', async () => {
    open();
    const claim = vi
      .fn()
      .mockReturnValueOnce(problem(404, 'INVITATION_NO_ACCOUNT', copy.noAccount))
      .mockReturnValue(json({ ok: true }));
    await renderApp('/invite', {
      session: 'anon',
      handlers: { ...previewed(preview()), '/api/v1/invitations/claim-existing': claim },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.have }));
    expect(await screen.findByText(copy.noAccount)).toBeInTheDocument();
    expect(goTo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: copy.have }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/auth/oidc/start?next=%2Finvite'));
  });

  it('waits for a click before accepting, then forgets the secret and opens the console', async () => {
    open();
    const accept = vi.fn(() =>
      json({ outcome: 'joined', kind: 'member', orgName: 'Agency', membership: null }),
    );
    await renderApp('/invite', {
      session: 'user',
      handlers: { ...previewed(preview()), '/api/v1/invitations/accept': accept },
    });
    const button = await screen.findByRole('button', { name: copy.accept });
    expect(accept).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('passbook.invite')).toBe(SECRET);
    await userEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'Joined Agency' })).toBeInTheDocument();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('passbook.invite')).toBeNull();
    expect(screen.getByRole('link', { name: copy.openAdmin })).toHaveAttribute('href', '/admin');
  });

  it('sends a developer who gained a group through one more sign-in', async () => {
    open(`d_${'b'.repeat(43)}`);
    await renderApp('/invite', {
      session: 'user',
      handlers: {
        ...previewed(preview({ kind: 'developer', developer: true, roles: [] })),
        '/api/v1/invitations/accept': () =>
          json({ outcome: 'refresh', kind: 'developer', orgName: 'Agency', membership: null }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.accept }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/auth/oidc/start?next=%2Fdevelopers'));
  });

  it('asks an email-link session to sign in with Polaris ID, and never accepts for it', async () => {
    open();
    const accept = vi.fn();
    await renderApp('/invite', {
      session: 'user',
      amr: 'magic_link',
      handlers: { ...previewed(preview()), '/api/v1/invitations/accept': accept },
    });
    expect(await screen.findByText('Sign in with Polaris ID to join Agency.')).toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
  });

  it('shows the server line when the signed-in address is not the invited one', async () => {
    open();
    await renderApp('/invite', {
      session: 'user',
      handlers: {
        ...previewed(preview()),
        '/api/v1/invitations/accept': () =>
          problem(
            403,
            'INVITATION_EMAIL_MISMATCH',
            'This invitation is for a•••@agency.test. Sign in with that address.',
          ),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.accept }));
    expect(
      await screen.findByText(
        'This invitation is for a•••@agency.test. Sign in with that address.',
      ),
    ).toBeInTheDocument();
    // Refused for this address: signing in again leads now.
    expect(screen.queryByRole('button', { name: copy.accept })).toBeNull();
    expect(screen.getByRole('link', { name: copy.signIn })).toBeInTheDocument();
  });
});
