import {
  type ConnectionFilesPort,
  ConnectorError,
  type ConnectorFile,
  type ConnectorFileRef,
  type UpstreamRecord,
} from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { digestOf, type Entry, entriesOf, PAGE_SIZE, parseFile } from './files-parse.ts';
import { takeUpload, zoneOf } from './files-service.ts';
import { readPage, readRefs, readSource, readSummary } from './files-store.ts';
import { type FileRow, fileInState, getFile, supersededOf } from './repo-files.ts';

/** Whose files a context reads: a saved connection's revisions, or the draft an unsaved test names. */
export type FilesBinding =
  | { orgId: string; connectionId: string }
  | { orgId: string; draftId: string | null; idPointer?: string };

const refuse = (): never => {
  throw new ConnectorError('CONFIG', { permanent: true });
};

const fileOf = (row: FileRow, pages = row.pages): ConnectorFile => ({
  id: row.id,
  revision: row.revision,
  format: row.format,
  rows: row.rows,
  columns: row.columnLabels,
  pages,
  skipped: { noId: row.skippedNoId ?? 0, duplicate: row.skippedDuplicate ?? 0 },
});

/** The record of `ref` in a sorted ref list, through one page read. */
async function findIn(
  refs: readonly ConnectorFileRef[],
  ref: string,
  page: (n: number) => Promise<Entry[]>,
): Promise<UpstreamRecord | null> {
  let lo = 0;
  let hi = refs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = refs[mid];
    if (!at) return null;
    if (at.ref === ref)
      return ((await page(at.page)).find((e) => e.ref === ref)?.record ??
        null) as UpstreamRecord | null;
    if (at.ref < ref) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function storedPort(ctx: ServiceContext, orgId: string, connectionId: string): ConnectionFilesPort {
  /** Only a revision the connection holds as current or superseded can be read. */
  const owned = async (fileId: string): Promise<FileRow> => {
    const row = await getFile(ctx.env.DB, orgId, fileId);
    if (
      !row ||
      row.connectionId !== connectionId ||
      (row.state !== 'current' && row.state !== 'superseded')
    )
      return refuse();
    return row;
  };
  const page = async (fileId: string, n: number): Promise<Entry[]> => {
    const row = await owned(fileId);
    return (await readPage(ctx, orgId, row.id, row.bindId ?? refuse(), n)) ?? refuse();
  };
  return {
    current: async () => {
      const row = await fileInState(ctx.env.DB, orgId, connectionId, 'current');
      return row ? fileOf(row) : null;
    },
    previous: async (limit) =>
      (await supersededOf(ctx.env.DB, orgId, connectionId, Math.max(0, limit))).map((r) =>
        fileOf(r),
      ),
    page: async (fileId, n) => (await page(fileId, n)) as { ref: string; record: UpstreamRecord }[],
    refs: async (fileId) => {
      const row = await owned(fileId);
      return (await readRefs(ctx, orgId, row.id, row.bindId ?? refuse())) ?? refuse();
    },
    find: async (fileId, ref) => {
      const row = await owned(fileId);
      const refs = (await readRefs(ctx, orgId, row.id, row.bindId ?? refuse())) ?? refuse();
      return findIn(refs, ref, (n) => page(fileId, n));
    },
  };
}

/** An unsaved test reads the draft by parsing its stored source once; no pages exist before the file is bound. */
function draftPort(
  ctx: ServiceContext,
  orgId: string,
  draftId: string | null,
  idPointer: string | undefined,
): ConnectionFilesPort {
  let loaded: Promise<{ row: FileRow; entries: Entry[]; refs: ConnectorFileRef[] }> | undefined;
  const load = () => {
    loaded ??= (async () => {
      if (draftId === null) return refuse();
      const row = await getFile(ctx.env.DB, orgId, draftId);
      if (row?.state !== 'draft' || (row.expiresAt ?? 0) <= ctx.clock.now()) return refuse();
      const bytes = (await readSource(ctx, orgId, draftId)) ?? refuse();
      // Each test over a draft re-parses the stored file: it spends the same hourly allowance as an upload.
      await takeUpload(ctx, orgId);
      const pointer =
        idPointer ?? (await readSummary(ctx, orgId, draftId))?.idCandidates[0] ?? refuse();
      const file = parseFile(
        ctx,
        orgId,
        bytes,
        { sheet: row.sheet ?? undefined, recordsPointer: row.recordsPointer ?? undefined },
        await zoneOf(ctx, orgId),
      );
      const { entries, noId, duplicate } = entriesOf(file.records, pointer);
      const refs: ConnectorFileRef[] = [];
      for (const [i, e] of entries.entries())
        refs.push({
          ref: e.ref,
          digest: await digestOf(e.record),
          page: Math.floor(i / PAGE_SIZE),
        });
      refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
      return { row: { ...row, skippedNoId: noId, skippedDuplicate: duplicate }, entries, refs };
    })();
    return loaded;
  };
  const pageOf = async (fileId: string, n: number): Promise<Entry[]> => {
    const { row, entries } = await load();
    if (fileId !== row.id) return refuse();
    return entries.slice(n * PAGE_SIZE, (n + 1) * PAGE_SIZE);
  };
  return {
    current: async () => {
      if (draftId === null) return null;
      const { row, entries } = await load();
      return fileOf(row, Math.ceil(entries.length / PAGE_SIZE));
    },
    previous: async () => [],
    page: async (fileId, n) =>
      (await pageOf(fileId, n)) as { ref: string; record: UpstreamRecord }[],
    refs: async (fileId) => {
      const { row, refs } = await load();
      return fileId === row.id ? refs : refuse();
    },
    find: async (fileId, ref) => {
      const { row, refs } = await load();
      return fileId === row.id ? findIn(refs, ref, (n) => pageOf(fileId, n)) : refuse();
    },
  };
}

/** Read-only files of one connection, or of the draft an unsaved test names. Connectors never see D1 or R2. */
export function filesPort(ctx: ServiceContext, binding: FilesBinding): ConnectionFilesPort {
  return 'connectionId' in binding
    ? storedPort(ctx, binding.orgId, binding.connectionId)
    : draftPort(ctx, binding.orgId, binding.draftId, binding.idPointer);
}
