import { createFetchClient, type OperationsClient } from '../../ui/operation/client.ts';
import { createBearerFetch, PORTAL_READ, type ToolApiDeps } from './api.ts';

/** The activity tray's client for a context: the same token, so it sees and acts on that Test only. */
export function createTestOperationsClient(deps: ToolApiDeps): OperationsClient {
  const bearerFetch = createBearerFetch(deps);
  return createFetchClient({
    fetch: (input, init) => {
      // The tray's polling reads are the page's own: the request log leaves them out of Calls.
      const headers = new Headers(init?.headers);
      if (!init?.method || init.method === 'GET')
        for (const [k, v] of Object.entries(PORTAL_READ)) headers.set(k, v);
      return bearerFetch(String(input), { ...init, headers });
    },
  });
}
