import { readFileSync } from 'node:fs';
import { type APIRequestContext, type Browser, expect, request } from '@playwright/test';
import { e2eOrigin } from '../../tools/lib/e2e-ports.ts';
import { type Role, saveState, startOidcAs, stateFile } from './auth.ts';

export const BASE = e2eOrigin;

// biome-ignore lint/suspicious/noExplicitAny: loosely typed test-side API payloads
type Json = any;

export interface Api {
  ctx: APIRequestContext;
  get<T = Json>(path: string): Promise<T>;
  send<T = Json>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
  dispose(): Promise<void>;
}

/** Real API client acting as a signed-in role (same cookie + CSRF rules as the browser). */
export async function apiAs(role: Role): Promise<Api> {
  return apiFrom(await request.newContext({ baseURL: BASE, storageState: stateFile(role) }));
}

/** An Api over an existing request context, such as a page's after a fresh sign-in. */
export async function apiFrom(ctx: APIRequestContext): Promise<Api> {
  const session = await (await ctx.get('/api/v1/session')).json();
  const csrf = session.csrfToken as string;
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await ctx.fetch(path, {
      method,
      headers: { Origin: BASE, 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : undefined) as never;
  };
  return {
    ctx,
    get: (path) => send('GET', path),
    send,
    dispose: () => ctx.dispose(),
  };
}

export const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function firstOrg(api: Api): Promise<{ id: string; slug: string; name: string }> {
  const orgs = await api.get('/api/v1/orgs');
  const list = orgs.items ?? orgs;
  expect(list.length).toBeGreaterThan(0);
  return list[0];
}

/** The Generic blueprint: it never issues passes. Clone or use it to make a template. */
export const GENERIC_BLUEPRINT = 'baked:starter-generic';

/** The seed org's template, made from the Generic blueprint and released (see auth.setup.ts). */
export const seedTemplateId = (): string =>
  (JSON.parse(readFileSync('e2e/.auth/seed.json', 'utf8')) as { template: { id: string } }).template
    .id;

export type ReleaseMode = 'live' | 'test';

export interface TemplateRelease {
  id: string;
  templateId: string;
  orgId: string | null;
  mode: ReleaseMode;
  provider: 'apple';
  version: string;
  generation: number;
  candidateHash: string;
  source: 'approved' | 'system';
  action: 'release' | 'rollback' | 'system';
  candidateId: string | null;
  approvalId: string | null;
  previousReleaseId: string | null;
}

export interface TemplateReleaseList {
  active: TemplateRelease | null;
  items: TemplateRelease[];
}

export async function templateReleases(
  api: Api,
  orgId: string,
  templateId: string,
  mode: ReleaseMode = 'live',
): Promise<TemplateReleaseList> {
  const query = new URLSearchParams({ orgId, mode, provider: 'apple' });
  return api.send(
    'GET',
    `/api/v1/templates/${encodeURIComponent(templateId)}/releases?${query}`,
    undefined,
    { 'x-passbook-mode': mode },
  );
}

function assertReleaseScope(
  release: TemplateRelease,
  orgId: string,
  templateId: string,
  mode: ReleaseMode,
): void {
  if (
    !release.id ||
    !release.version ||
    !Number.isSafeInteger(release.generation) ||
    release.generation < 1 ||
    release.templateId !== templateId ||
    release.mode !== mode ||
    release.provider !== 'apple' ||
    (release.orgId !== orgId && !(release.orgId === null && release.source === 'system'))
  ) {
    throw new Error(`Release does not match ${templateId} in ${orgId} (${mode}/apple)`);
  }
}

export async function requireActiveTemplateRelease(
  api: Api,
  orgId: string,
  templateId: string,
  mode: ReleaseMode = 'live',
): Promise<TemplateRelease> {
  const { active } = await templateReleases(api, orgId, templateId, mode);
  if (!active) throw new Error(`Template ${templateId} has no active ${mode} release in ${orgId}`);
  assertReleaseScope(active, orgId, templateId, mode);
  return active;
}

/** Creates a pass through the real API (from the seed's template by default). */
export async function createPass(
  api: Api,
  orgId: string,
  options: {
    holder?: string;
    memberId?: string;
    email?: string;
    templateId?: string;
    input?: Record<string, unknown>;
    mode?: ReleaseMode;
    release?: TemplateRelease;
  } = {},
) {
  const memberId = options.memberId ?? uid('ID').toUpperCase();
  const templateId = options.templateId ?? options.release?.templateId ?? seedTemplateId();
  const mode = options.mode ?? 'live';
  const release =
    options.release ?? (await requireActiveTemplateRelease(api, orgId, templateId, mode));
  assertReleaseScope(release, orgId, templateId, mode);
  const seeded = templateId === seedTemplateId() && release.source === 'approved';
  if (
    !options.release &&
    !seeded &&
    (!templateId.startsWith('baked:') || release.source !== 'system')
  ) {
    throw new Error(`Pass creation requires an explicitly published release for ${templateId}`);
  }
  return api.send(
    'POST',
    '/api/v1/passes',
    {
      orgId,
      templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      mode,
      input: { holder: options.holder ?? `Holder ${memberId}`, memberId, ...(options.input ?? {}) },
      ...(options.email ? { holderEmail: options.email } : {}),
    },
    { 'Idempotency-Key': uid('idem'), 'x-passbook-mode': mode },
  );
}

/**
 * The admin signed in again just now, for actions that need a recent sign-in (webhook endpoints).
 * The stored session is minutes old by the time a long CI shard reaches the spec.
 */
export async function freshAdminApi(browser: Browser): Promise<Api> {
  const context = await browser.newContext({ storageState: stateFile('admin') });
  const page = await context.newPage();
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  // A new sign-in ends the old session, so the stored state must follow.
  await saveState(page, 'admin');
  const api = await apiFrom(context.request);
  return { ...api, dispose: () => context.close() };
}
