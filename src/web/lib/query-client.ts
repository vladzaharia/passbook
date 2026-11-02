import { QueryClient } from '@tanstack/react-query';
import { setCsrfProvider } from './api.ts';
import { isApiError } from './errors.ts';
import { sessionQuery } from './session.ts';

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
  setCsrfProvider(async () => {
    const session = await client.ensureQueryData(sessionQuery);
    return session.authenticated ? session.csrfToken : undefined;
  });
  return client;
}
