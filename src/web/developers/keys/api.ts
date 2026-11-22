import type { z } from 'zod';
import type {
  CreatedApiKeySchema,
  RotatedApiKeySchema,
} from '../../../shared/contracts/api-keys.ts';
import { MODE_HEADER } from '../../../shared/contracts/common.ts';

const API = '/api/v1/api-keys';

export type MintedKey = z.infer<typeof CreatedApiKeySchema>;
export type RolledKey = z.infer<typeof RotatedApiKeySchema>;

/** A refused call. `signInUrl` is set on `STEP_UP_REQUIRED` and `IDP_SIGN_IN_REQUIRED`. */
export class KeyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly signInUrl: string | undefined;
  readonly fields: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message: string,
    signInUrl?: string,
    fields: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.signInUrl = signInUrl;
    this.fields = fields;
  }
  get stepUp(): boolean {
    return this.code === 'STEP_UP_REQUIRED' || this.code === 'IDP_SIGN_IN_REQUIRED';
  }
}

async function failure(res: Response): Promise<KeyError> {
  let b: Record<string, unknown> = {};
  try {
    b = (await res.json()) as Record<string, unknown>;
  } catch {
    // Not JSON: the status says enough.
  }
  const fields: Record<string, string> = {};
  if (Array.isArray(b.issues))
    for (const e of b.issues as { path?: unknown; message?: unknown }[])
      if (typeof e.path === 'string' && typeof e.message === 'string') fields[e.path] = e.message;
  const text = [b.detail, b.title].find((v) => typeof v === 'string');
  return new KeyError(
    res.status,
    typeof b.code === 'string' ? b.code : 'ERROR',
    typeof text === 'string' ? text : `The request failed (${res.status}).`,
    typeof b.signInUrl === 'string' ? b.signInUrl : undefined,
    fields,
  );
}

/**
 * The portal's calls on the api-keys routes, as the session, in Test (a sandbox holds Test only). The secret is in
 * the answer of a mint or a roll and nowhere else: nothing here logs, stores or keeps it.
 */
export function keyApi(csrf: string, fetchFn: typeof fetch = (i, n) => fetch(i, n)) {
  async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-csrf-token': csrf,
        [MODE_HEADER]: 'test',
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }
  return {
    /** A personal Test key in the sandbox org. */
    mint: (input: { orgId: string; name: string; scopes: string[]; expiresAt: number }) =>
      send<MintedKey>('', 'POST', { ...input, kind: 'personal', mode: 'test' }),
    roll: (orgId: string, id: string, overlapHours: number) =>
      send<RolledKey>(`/${encodeURIComponent(id)}/rotate`, 'POST', { orgId, overlapHours }),
    revoke: (orgId: string, id: string) =>
      send<{ ok: true }>(`/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId)}`, 'DELETE'),
  };
}
export type KeyApi = ReturnType<typeof keyApi>;
