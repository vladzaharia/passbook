import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority, type TemplateAuthority } from './access.ts';
import type { ImportParams } from './import-pipeline.ts';
import type { Analysis } from './package/analyze.ts';
import { matchesImport } from './repo.ts';

export const stage = (p: ImportParams) => `uploads/${p.uploadId}/`;

export function importAuthority(p: ImportParams): TemplateAuthority {
  const authority = p.authority;
  if (
    !authority ||
    (p.orgId === null
      ? authority.kind !== 'platform'
      : authority.kind !== 'session' ||
        authority.orgId !== p.orgId ||
        authority.capability !== 'templates:author') ||
    !p.createdBy ||
    authority.userId !== p.createdBy
  ) {
    throw new ForbiddenError();
  }
  return authority;
}

/** Recheck the original upload and principal before reading or writing staged objects. */
export async function assertStageAuthority(
  ctx: ServiceContext,
  p: ImportParams,
): Promise<TemplateAuthority> {
  const authority = importAuthority(p);
  if (!(await matchesImport(ctx.env.DB, p))) throw new ForbiddenError();
  await assertTemplateAuthority(ctx, authority, true);
  return authority;
}

export interface Saved {
  name: string | null;
  analysis: Omit<Analysis, 'files' | 'tooling'> & { hasTooling: boolean };
}

export async function putJson(ctx: ServiceContext, key: string, value: unknown): Promise<void> {
  await ctx.env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function getJson<T>(ctx: ServiceContext, key: string): Promise<T> {
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw new Error(`Missing staged object ${key}`);
  return (await object.json()) as T;
}

export async function getBytes(ctx: ServiceContext, key: string): Promise<Uint8Array> {
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw new Error(`Missing staged object ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}
