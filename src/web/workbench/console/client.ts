import { useMemo } from 'react';
import { useSession } from '../../lib/session.ts';
import type { BenchGet } from '../bench/trace-events.ts';
import { createBearerFetch } from '../host/api.ts';
import { markSessionGone } from '../host/session-gone.ts';
import { dropToken, workbenchToken } from '../host/token.ts';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { spend } from './budget.ts';
import { drop, token, tokenHeld } from './token.ts';

/** One request to this origin's API with a bearer attached: the console's only way out. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

/**
 * How a console reaches the API. The Workbench page runs on the org's Workbench token (design §2.3);
 * a reference page's Try it still runs on the sandbox's try token. Both answer with the raw response.
 */
export interface ConsoleClient {
  send: Transport;
  /** GET under /api/v1 as JSON: what the template's sample and the Trace read with. */
  get: BenchGet;
  /** A token is held now, so reading the template for the first example mints nothing. */
  eager: () => boolean;
  /** The org this client calls as: the Workbench's. Absent on a reference page's Try it. */
  orgId?: string;
}

function getOf(send: Transport): BenchGet {
  return async <T>(path: string): Promise<T> => {
    const res = await send(`/api/v1${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Could not read ${path.split('?')[0]} (${res.status}).`);
    return (await res.json()) as T;
  };
}

/** The Workbench's client for one org: the same token client every tool runs on, counted in the Runs gauge. */
export function workbenchClient(orgId: string, csrf: string): ConsoleClient {
  const bearer = createBearerFetch({
    orgId,
    token: () => workbenchToken(orgId, csrf),
    drop: (used) => dropToken(orgId, used),
    onSessionGone: markSessionGone,
  });
  const send: Transport = (path, init) => {
    spend();
    return bearer(path, { ...init, redirect: 'error' });
  };
  return { send, get: getOf(send), eager: () => true, orgId };
}

async function stale(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown };
  return body.code === 'UNAUTHENTICATED';
}

/** The reference page's Try it: the try token. Only the guard's own refusal means a stale one; it mints once more. */
export function tryClient(csrf: string): ConsoleClient {
  const once = async (path: string, init: RequestInit) => {
    const bearer = await token(csrf);
    spend();
    return fetch(path, {
      ...init,
      redirect: 'error',
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${bearer}` },
    });
  };
  const send: Transport = async (path, init) => {
    let res = await once(path, init);
    if (res.status === 401 && (await stale(res))) {
      drop();
      res = await once(path, init);
    }
    return res;
  };
  return { send, get: getOf(send), eager: tokenHeld };
}

/** The signed-in person's client for the org this page is in; null outside a context (browse only). */
export function useConsoleClient(): ConsoleClient | null {
  const orgId = useOptionalToolHost()?.context.orgId;
  const csrf = useSession().authed?.csrfToken;
  return useMemo(() => (orgId ? workbenchClient(orgId, csrf ?? '') : null), [orgId, csrf]);
}
