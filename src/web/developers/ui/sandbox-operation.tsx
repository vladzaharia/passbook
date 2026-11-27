import { type ReactNode, useMemo } from 'react';
import { createFetchClient, OperationsProvider } from '../../ui/operation/client.ts';

/** One operations client for the page, with the session's write token (the site has no router or query cache). */
export function SandboxOperations({ csrf, children }: { csrf: string; children: ReactNode }) {
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  return <OperationsProvider client={client}>{children}</OperationsProvider>;
}
