import { useMutation } from '@tanstack/react-query';
import type { z } from 'zod';
import { ProbeResultSchema } from '@/shared/contracts/connection-probe.ts';
import { api } from '../../../lib/api.ts';
import { ApiError, errorMessage } from '../../../lib/errors.ts';

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export interface ProbeRequest {
  /** The nested config as it would be saved. */
  config: Record<string, unknown>;
  /** Only the secrets the user typed; a saved connection uses its stored ones otherwise. */
  secrets?: Record<string, string> | undefined;
  /** The previous result's `page.next`. */
  next?: string | undefined;
}

/** One list page of the REST API through the server, as a sync would read it. Nothing is stored. */
export function useRestProbe({ orgId, connectionId }: { orgId: string; connectionId?: string }) {
  return useMutation({
    mutationFn: (req: ProbeRequest) => {
      const body = {
        config: req.config,
        ...(req.secrets && Object.keys(req.secrets).length > 0 ? { secrets: req.secrets } : {}),
        target: 'list' as const,
        ...(req.next ? { next: req.next } : {}),
      };
      return connectionId
        ? api.post(
            `/api/v1/connections/${encodeURIComponent(connectionId)}/probe`,
            ProbeResultSchema,
            body,
          )
        : api.post('/api/v1/connections/probe', ProbeResultSchema, {
            ...body,
            orgId,
            connectorType: 'http-json',
          });
    },
  });
}

const COPY: Record<string, (c: { status?: number; wait: number; host: string }) => string> = {
  AUTH: () => 'The API refused the credentials (401). Check the token and test again.',
  FORBIDDEN: () => "The credentials can't read this path (403). Check the key's permissions.",
  NOT_FOUND: () => 'Nothing at this address (404). Check the base URL and path.',
  RATE_LIMITED: (c) => `The API asked us to slow down (429). Try again in ${c.wait} s.`,
  TIMEOUT: () => 'No answer in 15 seconds. Check the address and try again.',
  UPSTREAM: (c) => `The API failed (${c.status ?? 500}). Try again later.`,
  UNSAFE_URL: () => "PassBook can't call this address. Use a public https URL.",
  REDIRECT_BLOCKED: () => 'The API redirected elsewhere. Use the final URL.',
  NOT_JSON: () => "The answer isn't JSON. Check the path.",
  TOO_LARGE: () => 'The page is over 512 KiB. Set a smaller page size.',
  NO_RECORDS: () => 'No list at this path. Pick the records array in the response.',
  OFF_ORIGIN: (c) => `The next page is on another host. PassBook follows links on ${c.host} only.`,
  CONFIG: () => 'The configuration is invalid. Check the fields above.',
};

export interface ProbeFailure {
  code: string;
  line: string;
}

/** One line for a failed probe: its code and what to do. Null when the probe passed. */
export function probeFailure(result: ProbeResult, host: string): ProbeFailure | null {
  if (result.ok || !result.errorCode) return null;
  const wait = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000));
  const line = COPY[result.errorCode]?.({ status: result.request?.status, wait, host });
  return { code: result.errorCode, line: line ?? 'The probe failed.' };
}

/** A request the platform itself refused: its rate limit, a permission, a bad body. */
export function requestFailure(error: unknown): ProbeFailure {
  // The kit opens the confirm dialog itself; the line says what to do after it.
  if (error instanceof ApiError && error.code === 'STEP_UP_REQUIRED')
    return { code: 'STEP_UP_REQUIRED', line: "Confirm it's you, then fetch again." };
  if (error instanceof ApiError && error.status === 429) {
    const wait = error.retryAfter ? `${error.retryAfter} s` : 'a moment';
    return { code: 'RATE_LIMITED', line: `Too many fetches. Try again in ${wait}.` };
  }
  return { code: error instanceof ApiError ? error.code : 'ERROR', line: errorMessage(error) };
}

export function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return 'the base URL';
  }
}
