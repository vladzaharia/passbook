import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import type { InputValues } from './model.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** The Try it token lives 15 minutes; renew it two minutes early. Memory only, never a URL or storage. */
const RENEW_BEFORE_MS = 2 * 60_000;
const API = '/api/v1';

/** Marks a background read as the portal's own: the workbench leaves it out of Calls. */
export const PORTAL_READ = { 'x-passbook-client': 'portal' } as const;

export interface Built {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  assetNames: string[];
}

export interface Created {
  id: string;
  downloadUrl: string;
}

export class LiveError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The first line of a problem+json body, or a plain sentence. Nothing from the response is shown as HTML. */
async function failure(res: Response): Promise<LiveError> {
  let code: string | undefined;
  let detail = 'The request failed. Try again.';
  try {
    const body = (await res.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // Not JSON: keep the plain sentence.
  }
  return new LiveError(res.status, code, detail);
}

/** One call, as the quickstart shows it: the status and timing beside the body or the problem. */
export interface Sent<T> {
  ok: boolean;
  status: number;
  ms: number;
  requestId: string | null;
  replayed: boolean;
  etag: string | null;
  body: T | null;
  problem: { code: string | undefined; detail: string } | null;
}

export type Connection =
  | { state: 'signed-out' }
  | { state: 'no-sandbox' }
  | { state: 'ready'; client: LiveClient };

export class LiveClient {
  #token: { value: string; expiresAt: number } | null = null;

  readonly #csrf: string;
  readonly #held: (() => Promise<string>) | undefined;
  readonly sandbox: { templateId: string | null; orgSlug: string };

  /** `held`: the Workbench token's provider. With it the client mints no Try it token of its own. */
  constructor(
    csrf: string,
    sandbox: { templateId: string | null; orgSlug: string },
    held?: () => Promise<string>,
  ) {
    this.#csrf = csrf;
    this.sandbox = sandbox;
    this.#held = held;
  }

  async #bearer(): Promise<string> {
    if (this.#held) return this.#held();
    const now = Date.now();
    if (this.#token && this.#token.expiresAt - RENEW_BEFORE_MS > now) return this.#token.value;
    const res = await fetch(`${API}/developer/try-token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': this.#csrf },
    });
    if (!res.ok) throw await failure(res);
    const body = (await res.json()) as { token: string; expiresAt: number };
    this.#token = { value: body.token, expiresAt: body.expiresAt };
    return body.token;
  }

  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await this.#bearer()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra.headers,
      },
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }

  /** Any call with the Try it token; an answer that is not 2xx comes back as `problem`, not a throw. */
  async send<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Sent<T>> {
    const bearer = await this.#bearer();
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new LiveError(0, 'NETWORK', 'PassBook did not answer.');
    }
    const ms = Math.round(performance.now() - started);
    const meta = {
      status: res.status,
      ms,
      requestId: res.headers.get('x-request-id'),
      replayed: res.headers.get('idempotent-replayed') === 'true',
      etag: res.headers.get('etag'),
    };
    if (res.ok) return { ok: true, ...meta, body: (await res.json()) as T, problem: null };
    const err = await failure(res);
    return { ok: false, ...meta, body: null, problem: { code: err.code, detail: err.message } };
  }

  template(id: string): Promise<Template> {
    return this.#call('GET', `/templates/${encodeURIComponent(id)}`);
  }

  /** Dry run: builds pass.json for the input, signs nothing, writes nothing. */
  async preview(id: string, input: InputValues, signal?: AbortSignal): Promise<Built> {
    return this.#call(
      'POST',
      `/templates/${encodeURIComponent(id)}/preview`,
      { input },
      signal ? { signal } : {},
    );
  }

  /** A test pass in the sandbox: a preview, never installable. */
  create(templateId: string, input: InputValues): Promise<Created> {
    return this.#call(
      'POST',
      '/passes',
      { templateId, input },
      {
        headers: { 'idempotency-key': crypto.randomUUID() },
      },
    );
  }
}

/** Session, then sandbox, then a client. Nothing here runs until the visitor chose their sandbox. */
export async function connect(): Promise<Connection> {
  const session = await fetch(`${API}/session`, { headers: { accept: 'application/json' } });
  if (!session.ok) throw await failure(session);
  const who = (await session.json()) as { authenticated: boolean; csrfToken?: string };
  if (!who.authenticated || !who.csrfToken) return { state: 'signed-out' };
  const res = await fetch(`${API}/developer/sandbox`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw await failure(res);
  const { sandbox } = (await res.json()) as {
    sandbox: { templateId: string | null; orgSlug: string; closedAt: number | null } | null;
  };
  if (!sandbox || sandbox.closedAt) return { state: 'no-sandbox' };
  return { state: 'ready', client: new LiveClient(who.csrfToken, sandbox) };
}
