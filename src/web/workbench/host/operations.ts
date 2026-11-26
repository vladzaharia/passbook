import { createFetchClient, type OperationsClient } from '../../ui/operation/client.ts';
import { createBearerFetch, type ToolApiDeps } from './api.ts';

/** The activity tray's client for a context: the same token, so it sees and acts on that Test only. */
export function createTestOperationsClient(deps: ToolApiDeps): OperationsClient {
  const bearerFetch = createBearerFetch(deps);
  return createFetchClient({ fetch: (input, init) => bearerFetch(String(input), init) });
}
