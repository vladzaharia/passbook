// Issues one demo pass per template for the parity capture: org template from the blueprint (or a
// demo one that already exists), a live release, then a pass with the template's sample data.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import type { Personalization } from '../../../../src/passkit/types.ts';

const root = resolve(import.meta.dirname, '../../../..');
export const TEMPLATES_DIR = resolve(root, 'templates');

type Json = Record<string, unknown>;

/** Demo org templates that are exact copies of a blueprint; reused instead of making new ones. */
const DEMO_COPIES: Record<string, string> = {
  'starter-store-card': 'Northwind Store Card',
  'starter-event-ticket': 'Harbor Event Ticket',
  'starter-coupon': 'Northwind Coupon',
  'starter-generic': 'Northwind Member',
};

export type Subject = {
  slug: string;
  orgId: string;
  templateId: string;
  templateName: string;
  sample: Personalization;
};

export const bakedSlugs = (): string[] =>
  readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^(henrys|starter)-/.test(d.name))
    .map((d) => d.name)
    .sort();

export const sampleOf = (slug: string): Personalization =>
  (JSON.parse(readFileSync(resolve(TEMPLATES_DIR, slug, 'wallet.template.json'), 'utf8')) as Json)
    .sample as Personalization;

async function csrfOf(ctx: APIRequestContext): Promise<string> {
  return ((await (await ctx.get('/api/v1/session')).json()) as { csrfToken: string }).csrfToken;
}

async function ok<T = Json>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  const text = await res.text();
  if (!res.ok())
    throw new Error(`${res.url().replace(/\?.*/, '')} -> ${res.status()} ${text.slice(0, 240)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export class Api {
  readonly owner: APIRequestContext;
  private csrf: string;
  constructor(owner: APIRequestContext, csrf: string) {
    this.owner = owner;
    this.csrf = csrf;
  }
  static async open(owner: APIRequestContext) {
    return new Api(owner, await csrfOf(owner));
  }
  get = async <T = Json>(path: string) => ok<T>(await this.owner.get(path));
  post = async <T = Json>(path: string, data?: unknown, headers: Record<string, string> = {}) =>
    ok<T>(
      await this.owner.post(path, { data, headers: { 'x-csrf-token': this.csrf, ...headers } }),
    );
  del = async (path: string) =>
    ok(await this.owner.delete(path, { headers: { 'x-csrf-token': this.csrf } }));
  async templates(orgId: string): Promise<Json[]> {
    return ((await this.get(`/api/v1/templates?orgId=${orgId}&limit=200`)) as { items: Json[] })
      .items;
  }
}

/** Approves and publishes the first version of an org template when it has no live release. */
async function release(api: Api, orgId: string, id: string): Promise<void> {
  let version: string | undefined;
  for (let i = 0; i < 40 && !version; i++) {
    const t = await api.get<{ versions?: { version: string }[] }>(
      `/api/v1/templates/${id}?orgId=${orgId}`,
    );
    version = t.versions?.[0]?.version;
    if (!version) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!version) throw new Error(`Template ${id} never got a version.`);
  const scope = { orgId, mode: 'live', provider: 'apple' };
  const base = `/api/v1/templates/${id}`;
  const cand = await api.post<{ id: string; candidateHash: string }>(`${base}/candidates`, {
    ...scope,
    version,
  });
  const approval = await api.post<{ id: string }>(`${base}/candidates/${cand.id}/approve`, {
    ...scope,
    candidateHash: cand.candidateHash,
    alone: true,
  });
  await api.post(`${base}/releases`, {
    ...scope,
    candidateId: cand.id,
    approvalId: approval.id,
    candidateHash: cand.candidateHash,
    expectedGeneration: 0,
  });
}

/** The org template to issue from: henrys-* are baked into the Henry's org; starters get a copy. */
export async function subjectFor(
  api: Api,
  slug: string,
  orgs: { id: string; slug: string }[],
): Promise<Subject> {
  const find = (s: string) => orgs.find((o) => o.slug === s) as { id: string; slug: string };
  const sample = sampleOf(slug);
  if (slug.startsWith('henrys-')) {
    const org = find('henrys');
    const hit = (await api.templates(org.id)).find((t) => t.id === `baked:${slug}`);
    if (!hit) throw new Error(`baked:${slug} is not in the Henry's org.`);
    return {
      slug,
      orgId: org.id,
      templateId: String(hit.id),
      templateName: String(hit.name),
      sample,
    };
  }
  const org = find('northwind');
  const wanted = DEMO_COPIES[slug];
  const name = wanted ?? `Parity ${slug.replace('starter-', '')}`;
  const all = (await Promise.all(orgs.map((o) => api.templates(o.id)))).flat();
  let row = all.find((t) => t.name === name);
  if (!row) {
    row = await api.post(`/api/v1/templates/baked:${slug}/use`, { orgId: org.id, name });
  }
  const orgId = String(row?.orgId ?? org.id);
  const id = String(row?.id);
  if (!row?.activeVersion) await release(api, orgId, id);
  return { slug, orgId, templateId: id, templateName: name, sample };
}

/** Short-lived key per org: sessions issue only from a reviewed release, keys from the live one. */
export async function issueKey(api: Api, orgId: string) {
  const key = await api.post<{ id: string; secret: string }>('/api/v1/api-keys', {
    name: `Parity ${orgId.slice(-6)}`,
    orgId,
    scopes: ['passes:read', 'passes:write'],
    expiresAt: Date.now() + 3_600_000,
  });
  return { id: key.id, authorization: `Bearer ${key.secret}` };
}

/** The pass made for this template by an earlier run, or a new one with the sample data. */
export async function ensurePass(
  api: Api,
  base: string,
  subject: Subject,
  authorization: string,
  holderEmail: string,
): Promise<Json> {
  const externalId = `parity-${subject.slug}`;
  const rows = (
    (await api.get(
      `/api/v1/passes?orgId=${subject.orgId}&templateId=${encodeURIComponent(subject.templateId)}&limit=200`,
    )) as { items: Json[] }
  ).items;
  const old = rows.find((p) => p.externalId === externalId && p.status === 'active');
  if (old) return api.get(`/api/v1/passes/${old.id}?orgId=${subject.orgId}`);
  const res = await fetch(`${base}/api/v1/passes`, {
    method: 'POST',
    headers: {
      authorization,
      origin: base,
      'content-type': 'application/json',
      'idempotency-key': `parity-${subject.slug}-${Date.now()}`,
    },
    body: JSON.stringify({
      orgId: subject.orgId,
      templateId: subject.templateId,
      input: subject.sample,
      holderEmail,
      externalId,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`issue ${subject.slug} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as Json;
}
