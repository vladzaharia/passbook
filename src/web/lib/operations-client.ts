import { createFetchClient, type OperationsClient } from '../ui/operation/client.ts';
import { endSession, sessionCsrfToken, sessionPrincipal } from './api.ts';
import { problemToError } from './errors.ts';
import { modeHeaders } from './mode.ts';
import { isStepUp, requestStepUp } from './step-up.ts';

/**
 * The kit's operations client over the SPA's session: the CSRF token on writes, Test mode's
 * header, a 401 that ends the session (once, for the principal that made the call), and a
 * step-up answer that opens the sign-in dialog. The kit's own fetch client keeps the ETag and 304.
 */
export function createSessionOperationsClient(
  doFetch: typeof fetch = (...a) => fetch(...a),
): OperationsClient {
  return createFetchClient({
    csrf: sessionCsrfToken,
    headers: modeHeaders,
    fetch: async (input, init) => {
      const principal = sessionPrincipal();
      const res = await doFetch(input, init);
      if (res.status === 401 && (principal === undefined || principal === sessionPrincipal()))
        endSession();
      else if (res.status === 403) {
        const body: unknown = await res
          .clone()
          .json()
          .catch(() => undefined);
        const error = problemToError(res.status, body);
        if (isStepUp(error)) requestStepUp(error.signInUrl);
      }
      return res;
    },
  });
}

let shared: OperationsClient | undefined;
export const sessionOperationsClient = (): OperationsClient =>
  (shared ??= createSessionOperationsClient());
