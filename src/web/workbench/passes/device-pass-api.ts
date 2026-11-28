import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DevicePassListSchema,
  DevicePassResponseSchema,
} from '@/shared/contracts/device-passes.ts';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { ApiError } from '../../lib/errors.ts';
import { pollEvery } from '../../lib/poll-backoff.ts';
import { useSession } from '../../lib/session.ts';
import { readJson } from '../host/session-fetch.ts';

const BASE = '/api/v1/developer/device-passes';
export const DEVICE_POLL_MS = 15_000;
const KEY = ['workbench', 'passes', 'device'] as const;

/**
 * A person's own calls (design §3.4): the session cookie and its CSRF token, never the Workbench token. Writes
 * carry an Idempotency-Key; a step-up answer opens the shared dialog and the click is made again after it.
 */
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  csrf: string | undefined,
  body?: unknown,
  signal?: AbortSignal,
) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['x-csrf-token'] = csrf ?? '';
    headers['idempotency-key'] = crypto.randomUUID();
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError({ status: 0, code: 'network', detail: STATE_COPY.network });
  }
  return res;
}

/** Your device passes: the open ones and the last 7 days. Read only while the view is open. */
export function useDevicePasses() {
  return useQuery({
    queryKey: KEY,
    queryFn: async ({ signal }) =>
      readJson(await call('GET', '', undefined, undefined, signal), DevicePassListSchema, BASE),
    refetchInterval: pollEvery(DEVICE_POLL_MS),
    refetchIntervalInBackground: false,
  });
}

export type DeviceMake =
  | { kind: 'make'; passId: string }
  | { kind: 'code'; id: string }
  | { kind: 'again'; id: string };

/** Make one, take a new code, or add again: each answers the device pass with its one-time code. */
export function useMakeDevicePass() {
  const csrf = useSession().authed?.csrfToken;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: DeviceMake) => {
      const [path, body] =
        v.kind === 'make'
          ? (['', { passId: v.passId }] as const)
          : ([`/${v.id}/${v.kind === 'code' ? 'code' : 'again'}`, undefined] as const);
      const out = await readJson(
        await call('POST', path, csrf, body ?? {}),
        DevicePassResponseSchema,
        BASE,
      );
      return out.devicePass;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useVoidDevicePass() {
  const csrf = useSession().authed?.csrfToken;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await readJson(await call('DELETE', `/${id}`, csrf), DevicePassResponseSchema, BASE))
        .devicePass,
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
