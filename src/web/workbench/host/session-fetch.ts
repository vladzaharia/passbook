import type { z } from 'zod';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { ApiError, problemToError } from '../../lib/errors.ts';
import { isStepUp, requestStepUp } from '../../lib/step-up.ts';

/**
 * Account-level calls ride the session cookie: the contexts, the token mint, the sandbox
 * lifecycle. They are Test or mode-free by construction, so they carry no mode header either.
 * Tenant calls never come here; they go through the token client (api.ts).
 */
export async function sessionJson<S extends z.ZodType>(
  path: string,
  schema: S,
  init: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: unknown;
    csrf?: string;
    signal?: AbortSignal;
    /** Sees the response before its body is read (the mint reads the server's `Date`). */
    onResponse?: (res: Response) => void;
  } = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.csrf) headers['x-csrf-token'] = init.csrf;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new ApiError({ status: 0, code: 'network', detail: STATE_COPY.network });
  }
  init.onResponse?.(res);
  return readJson(res, schema, path);
}

/** One reading of a response for both clients: problem+json to `ApiError`, a body to its schema. */
export async function readJson<S extends z.ZodType>(
  res: Response,
  schema: S,
  path: string,
): Promise<z.infer<S>> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // A proxy's HTML: the status decides the error below, or the schema refuses it.
    data = undefined;
  }
  if (!res.ok) {
    const wait = Number(res.headers.get('retry-after'));
    const error = problemToError(res.status, data, wait > 0 ? wait : undefined);
    if (isStepUp(error)) requestStepUp(error.signInUrl);
    throw error;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError({
      status: 502,
      code: 'invalid_response',
      detail: `Unexpected response from ${path.split('?')[0]}.`,
    });
  }
  return parsed.data;
}
