// What a journey step can use: API clients per role (with CSRF), dev mail, a holder made on the fly.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type APIRequestContext, request } from '@playwright/test';
import { oidc, open, signedIn } from './auth.ts';
import type { Role } from './routes.ts';

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API payloads
type Json = any;

export class Api {
  readonly ctx: APIRequestContext;
  private csrf: string;
  private extra: Record<string, string>;
  constructor(ctx: APIRequestContext, csrf: string, extra: Record<string, string> = {}) {
    this.ctx = ctx;
    this.csrf = csrf;
    this.extra = extra;
  }

  /** The same session, acting in Test mode (the console's mode header). */
  get test(): Api {
    return new Api(this.ctx, this.csrf, { ...this.extra, 'x-passbook-mode': 'test' });
  }

  /** The status and parsed body, whatever the status; for steps that expect a refusal. */
  async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json }> {
    const isForm = body instanceof Uint8Array || typeof body === 'string';
    const res = await this.ctx.fetch(path, {
      method,
      headers: { ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...this.extra, ...headers },
      ...(body === undefined
        ? {}
        : isForm
          ? { data: Buffer.from(body as Uint8Array) }
          : { data: body }),
      maxRedirects: 0,
    });
    const text = await res.text();
    let parsed: Json = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON: keep the text */
    }
    return { status: res.status(), body: parsed };
  }

  private async ok<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await this.send(method, path, body, headers);
    if (res.status >= 400)
      throw new Error(
        `${method} ${path.split('?')[0]} -> ${res.status} ${JSON.stringify(res.body).slice(0, 240)}`,
      );
    return res.body as T;
  }
  get = <T = Json>(path: string) => this.ok<T>('GET', path);
  post = <T = Json>(path: string, body?: unknown) => this.ok<T>('POST', path, body ?? {});
  put = <T = Json>(path: string, body?: unknown) => this.ok<T>('PUT', path, body ?? {});
  patch = <T = Json>(path: string, body: unknown, headers?: Record<string, string>) =>
    this.ok<T>('PATCH', path, body, headers);
  del = <T = Json>(path: string) => this.ok<T>('DELETE', path);
  /** Posts raw bytes (a CSV, a zip). */
  bytes = <T = Json>(path: string, data: Uint8Array | string, contentType: string) =>
    this.ok<T>('POST', path, data, { 'content-type': contentType });
}

export type Mail = { id: string; html: string; text: string; subject: string; mtime: number };

/** Dev mail written since `sinceMs` that links to this server (the temp dir is shared by every dev server). */
export function mailSince(base: string, sinceMs: number): Mail[] {
  const out: Mail[] = [];
  for (const dir of readdirSync(tmpdir())) {
    const folder = join(tmpdir(), dir, 'email');
    if (!dir.startsWith('miniflare-') || !existsSync(join(folder, 'email-html'))) continue;
    for (const f of readdirSync(join(folder, 'email-html'))) {
      const file = join(folder, 'email-html', f);
      const mtime = statSync(file).mtimeMs;
      if (mtime < sinceMs) continue;
      const html = readFileSync(file, 'utf8');
      if (!html.includes(`${base}/`)) continue;
      const textFile = join(folder, 'email-text', f.replace(/\.html?$/, '.txt'));
      out.push({
        id: f,
        html,
        text: existsSync(textFile) ? readFileSync(textFile, 'utf8') : '',
        subject: /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim() ?? '',
        mtime,
      });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

export type MagicLink = {
  mail: Mail;
  /** `/auth/magic?t=...`: the page the mail links to; showing it does not use the link up. */
  confirmPath: string;
  finish: () => Promise<{ storage: string; api: Api }>;
};

export type JourneyEnv = {
  base: string;
  /** Unique per run: external ids and addresses made by a journey carry it. */
  stamp: string;
  stateDir: string;
  /** Org slug to id. */
  orgs: Record<string, string>;
  /** The journey's org id (the console is pointed at it). */
  orgId: string;
  api: (role: Exclude<Role, 'anon'>) => Promise<Api>;
  /** The newest mail since `sinceMs` that `match` accepts; waits up to `waitMs`, null when none came. */
  mail: (sinceMs: number, match: (m: Mail) => boolean, waitMs?: number) => Promise<Mail | null>;
  /** Signs a mock Polaris ID account in (admins and developers; email links are for holders); returns the saved storage-state file and its API client. */
  signInOidc: (subject: string, key: string) => Promise<{ storage: string; api: Api }>;
  /** An API client with a short-lived key (passes:read, passes:write, ...) for an org: how seeds issue passes. */
  keyFor: (orgId: string, mode?: 'live' | 'test') => Promise<Api>;
  /** Runs when the journey ends (revoking a key). */
  onDone: (fn: () => Promise<void>) => void;
  cleanup: () => Promise<void>;
  /** Asks for a sign-in link; the mail and its confirm page can be shown before `finish` uses the link up. */
  magic: (email: string, key: string) => Promise<MagicLink>;
  /** Uses up a sign-in token from a mail (an invitation); saves the session as `key`. */
  consume: (token: string, key: string) => Promise<{ storage: string; api: Api }>;
  /** Values steps hand to later steps. */
  vars: Record<string, string>;
};

export async function apiFrom(ctx: APIRequestContext): Promise<Api> {
  const res = await ctx.get('/api/v1/session');
  const csrf = res.ok() ? (((await res.json()) as { csrfToken?: string }).csrfToken ?? '') : '';
  return new Api(ctx, csrf);
}

export function makeEnv(o: {
  base: string;
  stateDir: string;
  orgs: Record<string, string>;
  orgSlug: string;
  contexts: (role: Exclude<Role, 'anon'>) => Promise<APIRequestContext>;
}): JourneyEnv {
  const apis = new Map<string, Promise<Api>>();
  const keys = new Map<string, Promise<Api>>();
  const done: (() => Promise<void>)[] = [];
  const env: JourneyEnv = {
    base: o.base,
    stamp: new Date().toISOString().replace(/\D/g, '').slice(2, 14),
    stateDir: o.stateDir,
    orgs: o.orgs,
    orgId: o.orgs[o.orgSlug] ?? '',
    vars: {},
    api(role) {
      if (!apis.has(role)) apis.set(role, o.contexts(role).then(apiFrom));
      return apis.get(role) as Promise<Api>;
    },
    onDone: (fn) => {
      done.push(fn);
    },
    async cleanup() {
      for (const fn of done.splice(0).reverse()) await fn().catch(() => undefined);
    },
    keyFor(orgId, mode = 'live') {
      const id = `${orgId}|${mode}`;
      if (!keys.has(id))
        keys.set(
          id,
          (async () => {
            const session = await env.api('org');
            // A Test key is made in the console's Test mode.
            const owner = mode === 'test' ? session.test : session;
            const key = await owner.post('/api/v1/api-keys', {
              name: `Journey ${env.stamp}`,
              orgId,
              mode,
              scopes: ['passes:read', 'passes:write'],
              expiresAt: Date.now() + 3_600_000,
            });
            env.onDone(async () => {
              await owner.del(`/api/v1/api-keys/${key.id}?orgId=${orgId}`);
            });
            const ctx = await request.newContext({
              baseURL: o.base,
              extraHTTPHeaders: { authorization: `Bearer ${key.secret}` },
            });
            env.onDone(() => ctx.dispose());
            return new Api(ctx, '');
          })(),
        );
      return keys.get(id) as Promise<Api>;
    },
    async mail(sinceMs, match, waitMs = 20_000) {
      const deadline = Date.now() + waitMs;
      let kicked = 0;
      do {
        // Queued mail goes out on the next cron tick in dev; nudge it while waiting.
        if (Date.now() - kicked > 5_000) {
          kicked = Date.now();
          await fetch(`${o.base}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`).catch(() => undefined);
        }
        const found = mailSince(o.base, sinceMs).reverse().find(match);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 400));
      } while (Date.now() < deadline);
      return null;
    },
    async signInOidc(subject, key) {
      const storage = join(o.stateDir, `journey-${key}.json`);
      if (existsSync(storage)) {
        const saved = await open(o.base, storage);
        if (await signedIn(saved)) return { storage, api: await apiFrom(saved) };
        await saved.dispose();
      }
      const ctx = await open(o.base);
      await oidc(ctx, o.base, subject);
      mkdirSync(dirname(storage), { recursive: true });
      await ctx.storageState({ path: storage });
      return { storage, api: await apiFrom(ctx) };
    },
    async magic(email, key) {
      const ctx = await open(o.base);
      const since = Date.now() - 500;
      const asked = await ctx.post('/auth/magic/request', {
        data: { email, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' },
      });
      if (!asked.ok())
        throw new Error(
          `Sign-in link for ${email} refused (${asked.status()}); mail is capped at 5 an hour per address.`,
        );
      const mail = await env.mail(since, (m) => m.text.includes('/auth/magic?t='));
      const token = /\/auth\/magic\?t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
      if (!mail || !token) throw new Error(`No sign-in mail for ${email}.`);
      return {
        mail,
        confirmPath: `/auth/magic?t=${token}`,
        finish: () => env.consume(token, key),
      };
    },
    async consume(token, key) {
      const ctx = await open(o.base);
      const res = await ctx.post('/auth/magic/consume', { data: { token } });
      if (!res.ok()) throw new Error(`Sign-in link was refused (${res.status()}).`);
      const storage = join(o.stateDir, `journey-${key}.json`);
      mkdirSync(dirname(storage), { recursive: true });
      await ctx.storageState({ path: storage });
      return { storage, api: await apiFrom(ctx) };
    },
  };
  if (!env.orgId) throw new Error(`Org "${o.orgSlug}" does not exist; run tools/seed-demo.ts.`);
  return env;
}
