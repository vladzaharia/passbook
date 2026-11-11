import { QueryClient } from '@tanstack/react-query';
import { setCsrfProvider, setSessionPrincipalProvider } from './api.ts';
import { isApiError } from './errors.ts';
import { onModeChange } from './mode.ts';
import { membershipsQuery, sessionQuery } from './session.ts';

export function shouldRetry(failureCount: number, error: unknown): boolean {
  // A malformed body is deterministic; retrying only delays the error state.
  if (isApiError(error) && (!error.isTransient || error.code === 'invalid_response')) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  // Distinguish an old request even if the browser switches A -> B -> A before it completes.
  let principalId: string | undefined;
  let principalGeneration = 0;
  client.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== 1 || key[0] !== sessionQuery.queryKey[0]) return;
    const state = client.getQueryState(sessionQuery.queryKey);
    // A failed refresh keeps the data: only a different user is a different principal.
    const session = state?.data;
    const current = session?.authenticated ? session.user.id : undefined;
    if (current !== principalId) {
      principalId = current;
      principalGeneration += 1;
    }
  });
  // Session and organization grants are mode-independent; resource answers reload on a switch.
  onModeChange(() => {
    void client.resetQueries({
      predicate: (query) => {
        const key = query.queryKey;
        const memberships =
          key.length === membershipsQuery.queryKey.length &&
          key.every((value, index) => value === membershipsQuery.queryKey[index]);
        return key[0] !== sessionQuery.queryKey[0] && !memberships;
      },
    });
  });
  setCsrfProvider(async () => {
    const session = await client.ensureQueryData(sessionQuery);
    return session.authenticated ? session.csrfToken : undefined;
  });
  setSessionPrincipalProvider(() => {
    const session = client.getQueryState(sessionQuery.queryKey)?.data;
    return session?.authenticated ? `${principalGeneration}:${session.user.id}` : undefined;
  });
  return client;
}
