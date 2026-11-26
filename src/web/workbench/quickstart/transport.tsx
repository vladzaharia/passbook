import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { createFetchClient, OperationsProvider } from '../../ui/operation/index.ts';
import { createBearerFetch } from '../host/api.ts';
import { markSessionGone } from '../host/session-gone.ts';
import { dropToken, workbenchToken } from '../host/token.ts';

/** A call that goes out through the quickstart's transport. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * How the quickstart talks to the server. With a sandbox its tenant calls (the request log, the pass
 * client) carry its Workbench token; the person's own calls (their home, making and changing the
 * sandbox, its operations) are account-level and ride the session, because the server refuses a
 * `pbtry_` bearer on a session route. Never a mode header either way.
 */
export interface Transport {
  fetch: Fetcher;
  /** The sandbox's Workbench token, for the calls the pass client makes. Null before there is a sandbox. */
  token: (() => Promise<string>) | null;
  /** The key was replaced (reset, start over): the held token belongs to the old one. */
  forget: () => void;
}

const session: Transport = {
  fetch: (url, init) => fetch(url, { ...init, credentials: 'same-origin' }),
  token: null,
  forget: () => undefined,
};

export function useTransport(orgId: string | null, csrf: string): Transport {
  return useMemo(() => {
    if (!orgId) return session;
    const token = () => workbenchToken(orgId, csrf);
    return {
      fetch: createBearerFetch({
        orgId,
        token,
        drop: (used) => dropToken(orgId, used),
        onSessionGone: markSessionGone,
      }),
      token,
      forget: () => dropToken(orgId),
    };
  }, [orgId, csrf]);
}

const TransportContext = createContext<Transport>(session);
export const useQsTransport = (): Transport => useContext(TransportContext);

/** The transport for a subtree, and the operations client that follows it (the page has no router cache of its own). */
export function QsTransport({
  transport,
  csrf,
  children,
}: {
  transport: Transport;
  csrf: string;
  children: ReactNode;
}) {
  // A sandbox's own operations are the person's (starter rows): they are read and retried with the session.
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  return (
    <TransportContext.Provider value={transport}>
      <OperationsProvider client={client}>{children}</OperationsProvider>
    </TransportContext.Provider>
  );
}
