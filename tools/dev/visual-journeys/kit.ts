// Helpers shared by journeys: look things up, issue, wait for mail, tolerant UI clicks.
import type { HtmlView, PageView, Skip } from '../lib/journey.ts';
import type { Api, JourneyEnv, Mail } from '../lib/journey-env.ts';

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API payloads
export type Json = any;

export const tokenOf = (url: string): string =>
  url.split('/').filter(Boolean).pop()?.split('?')[0] ?? '';

/** A page of `role` at `path`; `rest` adds waitFor, prepare, storage. */
export const page = (
  role: PageView['role'],
  path: string,
  rest: Partial<Omit<PageView, 'kind' | 'role' | 'path'>> = {},
): PageView => ({ kind: 'page', role, path, ...rest });

export const mailView = (mail: Mail): HtmlView => ({ kind: 'html', html: mail.html });

/** The mail as a view, or a skip naming what never arrived. */
export const mailOrSkip = (mail: Mail | null, what: string): HtmlView | Skip =>
  mail ? mailView(mail) : { skip: `no ${what} mail arrived in the dev mail folder` };

/** An org template by name (the demo owner is org admin in every seeded org). */
export async function templateByName(env: JourneyEnv, name: string): Promise<Json> {
  const owner = await env.api('org');
  const list = await owner.get(`/api/v1/templates?orgId=${env.orgId}&limit=100`);
  const found = list.items.find((t: Json) => t.name === name);
  if (!found) throw new Error(`Template "${name}" not found; run tools/seed-demo.ts.`);
  return found;
}

/** Issues a pass with the run's key; `externalId` carries the run stamp so a rerun makes a new one. */
export async function issue(
  env: JourneyEnv,
  templateId: string,
  input: Record<string, unknown>,
  o: { holderEmail?: string; sendEmail?: boolean; key: string; mode?: 'test' },
): Promise<Json> {
  const keyed = await env.keyFor(env.orgId, o.mode);
  const res = await keyed.send(
    'POST',
    '/api/v1/passes',
    {
      orgId: env.orgId,
      templateId,
      input,
      externalId: `journey-${o.key}-${env.stamp}`,
      ...(o.holderEmail ? { holderEmail: o.holderEmail } : {}),
      ...(o.sendEmail ? { sendEmail: true } : {}),
    },
    { 'idempotency-key': `journey-${o.key}-${env.stamp}` },
  );
  if (res.status >= 400)
    throw new Error(`issue -> ${res.status} ${JSON.stringify(res.body).slice(0, 240)}`);
  return res.body;
}

export const passOf = (api: Api, env: JourneyEnv, id: string): Promise<Json> =>
  api.get(`/api/v1/passes/${id}?orgId=${env.orgId}`);

/** Approves and releases the template's newest version in Test mode (a no-op when one is live). */
export async function ensureTestRelease(env: JourneyEnv, templateId: string): Promise<void> {
  const owner = (await env.api('org')).test;
  const detail: Json = await owner.get(`/api/v1/templates/${templateId}?orgId=${env.orgId}`);
  const version = detail.versions?.[0]?.version;
  const scope = { orgId: env.orgId, mode: 'test', provider: 'apple' };
  const live: Json = await owner.get(
    `/api/v1/templates/${templateId}/releases?orgId=${env.orgId}&mode=test&provider=apple`,
  );
  if (live.active) return;
  const base = `/api/v1/templates/${templateId}`;
  const candidate: Json = await owner.post(`${base}/candidates`, { ...scope, version });
  const approval: Json = await owner.post(`${base}/candidates/${candidate.id}/approve`, {
    ...scope,
    candidateHash: candidate.candidateHash,
    alone: true,
  });
  await owner.post(`${base}/releases`, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });
}
