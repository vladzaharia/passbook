import type { z } from 'zod';
import type { ConnectionFileColumnSchema } from '../../../shared/contracts/connection-files.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { digestOf, type Entry, PAGE_SIZE } from './files-parse.ts';

/** What a draft shows the admin, kept beside the source so a read never parses the file again. */
export interface FileSummary {
  columns: z.infer<typeof ConnectionFileColumnSchema>[];
  preview: { header: string[]; rows: string[][] };
  sheets: string[];
  idCandidates: string[];
}

export interface StoredRef {
  ref: string;
  digest: string;
  page: number;
}

const ROOT = 'uploads/connection-files/';
const DELETE_BATCH = 1000;
const prefixOf = (orgId: string, fileId: string) => `${ROOT}${orgId}/${fileId}/`;
const rowsOf = (orgId: string, fileId: string, bindId: string) =>
  `${prefixOf(orgId, fileId)}rows/${bindId}/`;
const pageKey = (orgId: string, fileId: string, bindId: string, n: number) =>
  `${rowsOf(orgId, fileId, bindId)}${n}.json`;

export async function putSource(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  bytes: Uint8Array,
): Promise<void> {
  await ctx.env.BUCKET.put(`${prefixOf(orgId, fileId)}source`, bytes);
}

export async function putSummary(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  summary: FileSummary,
): Promise<void> {
  await ctx.env.BUCKET.put(`${prefixOf(orgId, fileId)}summary.json`, JSON.stringify(summary));
}

export async function readSource(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
): Promise<Uint8Array | null> {
  const object = await ctx.env.BUCKET.get(`${prefixOf(orgId, fileId)}source`);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

export async function readSummary(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
): Promise<FileSummary | null> {
  const object = await ctx.env.BUCKET.get(`${prefixOf(orgId, fileId)}summary.json`);
  return object ? ((await object.json()) as FileSummary) : null;
}

/** Writes the row pages and the sorted ref list; returns both so the caller can diff without reading back. */
export async function writeRows(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  bindId: string,
  entries: readonly Entry[],
): Promise<{ pages: number; refs: StoredRef[] }> {
  const refs: StoredRef[] = [];
  let pages = 0;
  for (let at = 0; at < entries.length; at += PAGE_SIZE) {
    const chunk = entries.slice(at, at + PAGE_SIZE);
    await ctx.env.BUCKET.put(pageKey(orgId, fileId, bindId, pages), JSON.stringify(chunk));
    for (const e of chunk) refs.push({ ref: e.ref, digest: await digestOf(e.record), page: pages });
    pages++;
  }
  refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  await ctx.env.BUCKET.put(`${rowsOf(orgId, fileId, bindId)}refs.json`, JSON.stringify(refs));
  return { pages, refs };
}

export async function readPage(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  bindId: string,
  n: number,
): Promise<Entry[] | null> {
  const object = await ctx.env.BUCKET.get(pageKey(orgId, fileId, bindId, n));
  return object ? ((await object.json()) as Entry[]) : null;
}

export async function readRefs(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  bindId: string,
): Promise<StoredRef[] | null> {
  const object = await ctx.env.BUCKET.get(`${rowsOf(orgId, fileId, bindId)}refs.json`);
  return object ? ((await object.json()) as StoredRef[]) : null;
}

async function deleteUnder(ctx: ServiceContext, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await ctx.env.BUCKET.list({
      prefix,
      limit: DELETE_BATCH,
      ...(cursor ? { cursor } : {}),
    });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await ctx.env.BUCKET.delete(keys);
    removed += keys.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
}

/** Every object of one file: source, summary, pages and refs. Lists the prefix, so stray objects go too. */
export const deleteFileObjects = (ctx: ServiceContext, orgId: string, fileId: string) =>
  deleteUnder(ctx, prefixOf(orgId, fileId));

/** One page of the files bucket: each file id seen, with its newest object's upload time. */
export async function listFileIds(
  ctx: ServiceContext,
  cursor: string | undefined,
  limit: number,
): Promise<{
  files: { orgId: string; fileId: string; newest: number }[];
  cursor: string | undefined;
}> {
  const listed = await ctx.env.BUCKET.list({ prefix: ROOT, limit, ...(cursor ? { cursor } : {}) });
  const seen = new Map<string, { orgId: string; fileId: string; newest: number }>();
  for (const o of listed.objects) {
    const [orgId, fileId] = o.key.slice(ROOT.length).split('/');
    if (!orgId || !fileId) continue;
    const key = `${orgId}/${fileId}`;
    const newest = Math.max(seen.get(key)?.newest ?? 0, o.uploaded.getTime());
    seen.set(key, { orgId, fileId, newest });
  }
  return { files: [...seen.values()], cursor: listed.truncated ? listed.cursor : undefined };
}
