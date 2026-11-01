// HTTP client for tools/seed-demo.ts: cookie sessions against a local dev server, never remote.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Throws unless `url` is http(s) on a loopback host. */
export function assertLocal(url: string): string {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to seed ${parsed.origin}: only localhost is allowed.`);
  }
  return parsed.origin;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed seed payloads
type Json = any;

export class Session {
  private cookies = new Map<string, string>();
  private csrf = '';
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  private keep(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        origin: this.base,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });
    this.keep(res);
    return res;
  }

  async send<T = Json>(method: string, path: string, body?: unknown, headers = {}): Promise<T> {
    const isBytes = body instanceof Uint8Array;
    const res = await this.raw(
      method,
      path,
      body === undefined ? undefined : isBytes ? (body as BodyInit) : JSON.stringify(body),
      {
        'content-type': isBytes ? 'application/octet-stream' : 'application/json',
        ...headers,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = JSON.parse(text).code;
      } catch {
        code = undefined;
      }
      throw new ApiError(
        res.status,
        code,
        `${method} ${path} -> ${res.status} ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = <T = Json>(path: string) => this.send<T>('GET', path);

  /** Every page of a list endpoint. */
  async all<T = Json>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page: Json = await this.get(
        `${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return items;
  }

  /** Signs in at /auth/breakglass and picks up the CSRF token. */
  async breakglass(token: string) {
    const res = await this.raw('POST', '/auth/breakglass', new URLSearchParams({ token }), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    if (res.status !== 302) throw new Error(`Break-glass sign-in failed (${res.status}).`);
    this.csrf = (await this.get('/api/v1/session')).csrfToken;
  }

  /**
   * Magic-link sign-in for a holder address, reading the link from the local mail directory.
   * Cloudflare's always-pass Turnstile token works with the dev test secret.
   */
  async magicLink(email: string, mailDir: string) {
    const before = mailFiles(mailDir);
    await retryRateLimited(() =>
      this.send('POST', '/auth/magic/request', { email, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    );
    const token = await nextMagicToken(mailDir, before);
    await retryRateLimited(() => this.send('POST', '/auth/magic/consume', { token }));
    this.csrf = (await this.get('/api/v1/session')).csrfToken;
  }
}

async function retryRateLimited<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 8) throw error;
      await new Promise((r) => setTimeout(r, 8_000));
    }
  }
}

function mailFiles(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir).flatMap((id) => {
      const text = join(dir, id, 'email-text');
      return existsSync(text) ? readdirSync(text).map((f) => join(text, f)) : [];
    }),
  );
}

async function nextMagicToken(dir: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const file of mailFiles(dir)) {
      if (before.has(file)) continue;
      const token = /\/auth\/magic\?t=([A-Za-z0-9_-]+)/.exec(readFileSync(file, 'utf8'))?.[1];
      if (token) return token;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in email under ${dir}. Is the dev server running from this tree?`);
}

/** Solid PNG with a centered disc, for per-pass image overrides. */
export function discPng(width: number, height: number, bg: number[], fg: number[]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const r = Math.min(width, height) * 0.32;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < r * r;
      raw.set(inside ? fg : bg, row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
