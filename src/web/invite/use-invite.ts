import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type InvitationAccept,
  InvitationAcceptSchema,
  InvitationClaimSchema,
  type InvitationPreview,
  InvitationPreviewSchema,
  InvitationSetupSchema,
} from '@/shared/contracts/invitations.ts';
import { INVITE_PATH, INVITE_SECRET } from '@/shared/invitation-link.ts';
import { isStrongAmr } from '@/shared/sign-in.ts';
import { api } from '../lib/api.ts';
import { ApiError, errorMessage } from '../lib/errors.ts';
import { useSession } from '../lib/session.ts';
import { goTo } from '../portal/goto.ts';
import { CHALLENGE_FAILED, CHALLENGE_WAIT_MS, useChallenge } from '../portal/use-magic-request.ts';

const KEY = 'passbook.invite';
const BASE = '/api/v1/invitations';
/** Back to this page after Polaris ID: the secret waits in this tab's session storage. */
export const SIGN_IN_HREF = `/auth/oidc/start?next=${encodeURIComponent(INVITE_PATH)}`;
const DEVELOPERS_HREF = `/auth/oidc/start?next=${encodeURIComponent('/developers')}`;

/**
 * The secret rides in the URL fragment, which no server, log or Referer ever sees. It is read once, kept in this tab's
 * session storage across the sign-in round trip, and taken off the address bar.
 */
function takeSecret(): string {
  let secret = window.location.hash.slice(1);
  try {
    if (secret) sessionStorage.setItem(KEY, secret);
    else secret = sessionStorage.getItem(KEY) ?? '';
  } catch {
    // Storage blocked: the secret lives only as long as this page.
  }
  if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  return INVITE_SECRET.test(secret) ? secret : '';
}

function forget(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

export type InviteView =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  /** `weak`: signed in by email link, which cannot accept. */
  | { kind: 'ready'; preview: InvitationPreview; weak: boolean }
  | { kind: 'accepting'; preview: InvitationPreview }
  | { kind: 'made'; preview: InvitationPreview }
  | { kind: 'joined'; preview: InvitationPreview; accepted: InvitationAccept };

export function useInvite() {
  const [secret] = useState(takeSecret);
  const { session, isPending: sessionPending, isError: sessionFailed } = useSession();
  const preview = useQuery({
    queryKey: ['invitation', secret],
    queryFn: ({ signal }) =>
      api.post(`${BASE}/preview`, InvitationPreviewSchema, { token: secret }, { signal }),
    enabled: secret !== '',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const challenge = useChallenge();
  const [phase, setPhase] = useState<'idle' | 'accepting' | 'made' | 'joined'>('idle');
  const [accepted, setAccepted] = useState<InvitationAccept | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<'create' | 'have' | null>(null);
  const started = useRef(false);

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.code === 'INVITATION_INVALID') {
      forget();
      setInvalid(true);
    } else if (cause instanceof ApiError && cause.code === 'IDP_SIGN_IN_REQUIRED') {
      setNeedSignIn(true);
    } else if (cause instanceof ApiError && cause.code === 'INVITATION_EMAIL_MISMATCH') {
      // The server's line names the address by its first letter, and says which one to sign in with.
      setError(cause.message);
    } else setError(errorMessage(cause));
  }, []);

  const strong = session?.authenticated === true && isStrongAmr(session.amr);
  const data = preview.data;
  useEffect(() => {
    if (!data || !strong || started.current) return;
    started.current = true;
    setPhase('accepting');
    api
      .post(`${BASE}/accept`, InvitationAcceptSchema, { token: secret })
      .then((result) => {
        forget();
        if (result.outcome === 'refresh') {
          goTo(DEVELOPERS_HREF);
          return;
        }
        setAccepted(result);
        setPhase('joined');
      })
      .catch((cause) => {
        setPhase('idle');
        fail(cause);
      });
  }, [data, strong, secret, fail]);

  /** A Turnstile token for the call: the one ready, or the next within a few seconds. */
  const token = useCallback(async () => {
    const now = challenge.takeNow();
    return now ?? (await challenge.wait(CHALLENGE_WAIT_MS));
  }, [challenge]);

  const create = useCallback(async () => {
    setError('');
    setWorking('create');
    // The tab opens inside the click so no blocker stops it; it is pointed at Polaris ID once the link exists.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const turnstileToken = await token();
      if (!turnstileToken) throw new Error(CHALLENGE_FAILED);
      const made = await api.post(`${BASE}/setup`, InvitationSetupSchema, {
        token: secret,
        turnstileToken,
      });
      if (tab) tab.location.href = made.setupUrl;
      else goTo(made.setupUrl);
      setPhase('made');
    } catch (cause) {
      tab?.close();
      fail(cause);
    } finally {
      setWorking(null);
    }
  }, [secret, token, fail]);

  const have = useCallback(async () => {
    setError('');
    setWorking('have');
    try {
      const turnstileToken = await token();
      if (!turnstileToken) throw new Error(CHALLENGE_FAILED);
      await api.post(`${BASE}/claim-existing`, InvitationClaimSchema, {
        token: secret,
        turnstileToken,
      });
      goTo(SIGN_IN_HREF);
    } catch (cause) {
      fail(cause);
    } finally {
      setWorking(null);
    }
  }, [secret, token, fail]);

  let view: InviteView;
  if (secret === '' || invalid || preview.isError) view = { kind: 'invalid' };
  else if (!data || sessionPending)
    view = sessionFailed ? { kind: 'invalid' } : { kind: 'loading' };
  else if (phase === 'joined' && accepted) view = { kind: 'joined', preview: data, accepted };
  else if (phase === 'accepting') view = { kind: 'accepting', preview: data };
  else if (phase === 'made') view = { kind: 'made', preview: data };
  else view = { kind: 'ready', preview: data, weak: session?.authenticated === true || needSignIn };

  return {
    view,
    error,
    working,
    create,
    have,
    widget: {
      resetKey: challenge.resetKey,
      onToken: challenge.onToken,
      onError: challenge.onError,
    },
    siteKey: session && !session.authenticated ? session.turnstileSiteKey : '',
  };
}
