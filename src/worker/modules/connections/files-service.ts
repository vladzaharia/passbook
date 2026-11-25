import type { z } from 'zod';
import type {
  UpdateConnectionFileSchema,
  UploadConnectionFileSchema,
} from '../../../shared/contracts/connection-files.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import type { Actor } from '../../platform/context.ts';
import { bump } from '../../platform/counters.ts';
import { RateLimitedError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import type { ConnectionAuthority } from './access.ts';
import { draftDto, type FileDto } from './files-dto.ts';
import {
  FileExpiredError,
  FileIdColumnMissingError,
  FileNotFoundError,
  FileStateError,
  rejectFile,
} from './files-errors.ts';
import {
  decodeContent,
  describeColumns,
  entriesOf,
  idCandidatesOf,
  type ParsedFile,
  parseFile,
  pointerOf,
  previewOf,
  sha256Hex,
} from './files-parse.ts';
import {
  deleteFileObjects,
  type FileSummary,
  putSource,
  putSummary,
  readSource,
  readSummary,
  writeRows,
} from './files-store.ts';
import { usableZone } from './files-values.ts';
import {
  type Bind,
  discardFile,
  type FileRow,
  getFile,
  insertDraft,
  openDrafts,
  updateDraft,
} from './repo-files.ts';
import { auditActor } from './service-shared.ts';

type Upload = z.infer<typeof UploadConnectionFileSchema>;
type Patch = z.infer<typeof UpdateConnectionFileSchema>;

const HOUR = 3_600_000;
/** A draft or an unapplied revision is kept this long. */
export const FILE_TTL_MS = 23 * HOUR;
export const UPLOADS_PER_HOUR = 30;
export const OPEN_DRAFTS = 20;

/** One upload, or one re-read of a stored file, against the org's hourly allowance. */
export async function takeUpload(ctx: ServiceContext, orgId: string): Promise<void> {
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR) * HOUR;
  const n = await bump(ctx.env.DB, `connection-file-upload:${orgId}`, window);
  if (n > UPLOADS_PER_HOUR)
    throw new RateLimitedError(
      Math.max(1, Math.ceil((window + HOUR - now) / 1000)),
      'Too many uploads this hour. Try again later.',
    );
}

export const zoneOf = async (ctx: ServiceContext, orgId: string): Promise<string> =>
  usableZone(await readOrgTimeZone(ctx.env.DB, orgId));

/** Decodes an upload body; the parser's refusals become responses. */
export function bytesOf(ctx: ServiceContext, orgId: string, body: Upload): Uint8Array {
  try {
    return decodeContent(body.content, body.encoding);
  } catch (error) {
    return rejectFile(ctx, orgId, error);
  }
}

export function summaryOf(file: ParsedFile): FileSummary {
  const columns = describeColumns(file);
  return {
    columns,
    preview: previewOf(file),
    sheets: file.sheets,
    idCandidates: idCandidatesOf(columns, file.records.length),
  };
}

export const rowOf = (
  id: string,
  orgId: string,
  state: FileRow['state'],
  name: string,
  bytes: Uint8Array,
  sha256: string,
  file: ParsedFile,
  actorId: string | null,
  now: number,
): FileRow => ({
  id,
  orgId,
  connectionId: null,
  revision: null,
  state,
  name,
  format: file.format,
  sheet: file.sheet,
  recordsPointer: file.recordsPointer,
  idPointer: null,
  columnLabels: file.columns,
  bytes: bytes.length,
  sha256,
  rows: file.records.length,
  columns: file.columns.length,
  pages: 0,
  skippedNoId: null,
  skippedDuplicate: null,
  diff: null,
  createdBy: actorId,
  createdAt: now,
  expiresAt: now + FILE_TTL_MS,
  supersededAt: null,
});

const audit = (
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  action: 'connection.file_upload' | 'connection.file_discard',
  targetId: string | null,
  row: FileRow,
) =>
  recordAudit(ctx, {
    orgId,
    ...auditActor(actor),
    action,
    targetType: 'connection',
    targetId,
    detail: { fileId: row.id, format: row.format, rows: row.rows, bytes: row.bytes },
  });

export { audit as auditFile };

/** A draft of this org that can still be read or bound. An expired one answers FILE_EXPIRED, a bound one 404. */
export async function requireDraft(
  ctx: ServiceContext,
  orgId: string,
  id: string,
): Promise<FileRow> {
  const row = await getFile(ctx.env.DB, orgId, id);
  if (!row || (row.state !== 'draft' && row.state !== 'expired')) throw new FileNotFoundError();
  if (row.state === 'expired' || (row.expiresAt ?? 0) <= ctx.clock.now())
    throw new FileExpiredError();
  return row;
}

/** Parses a new file into a draft and keeps its source and summary in R2. */
export async function createDraft(
  ctx: ServiceContext,
  actor: Actor,
  authority: ConnectionAuthority,
  body: Upload,
): Promise<FileDto> {
  const orgId = authority.orgId;
  const now = ctx.clock.now();
  if ((await openDrafts(ctx.env.DB, orgId, now)) >= OPEN_DRAFTS)
    throw new RateLimitedError(60, 'Too many open uploads. Discard one first.');
  await takeUpload(ctx, orgId);
  const bytes = bytesOf(ctx, orgId, body);
  const file = parseFile(ctx, orgId, bytes, body, await zoneOf(ctx, orgId));
  const summary = summaryOf(file);
  const row = rowOf(
    ctx.ids.id(),
    orgId,
    'draft',
    body.name,
    bytes,
    await sha256Hex(bytes),
    file,
    actor.id,
    now,
  );
  try {
    await putSource(ctx, orgId, row.id, bytes);
    await putSummary(ctx, orgId, row.id, summary);
    await insertDraft(ctx, { orgId, authority }, row);
  } catch (error) {
    await deleteFileObjects(ctx, orgId, row.id).catch(() => undefined);
    throw error;
  }
  await audit(ctx, actor, orgId, 'connection.file_upload', null, row);
  return draftDto(row, summary);
}

export async function readDraft(ctx: ServiceContext, orgId: string, id: string): Promise<FileDto> {
  const row = await requireDraft(ctx, orgId, id);
  const summary = await readSummary(ctx, orgId, id);
  if (!summary) throw new FileExpiredError();
  return draftDto(row, summary);
}

/** Reads the stored source again with another sheet or records path. Counts against the upload allowance. */
export async function reparseDraft(
  ctx: ServiceContext,
  authority: ConnectionAuthority,
  id: string,
  patch: Patch,
): Promise<FileDto> {
  const orgId = authority.orgId;
  const row = await requireDraft(ctx, orgId, id);
  await takeUpload(ctx, orgId);
  const bytes = await readSource(ctx, orgId, id);
  if (!bytes) throw new FileExpiredError();
  const file = parseFile(
    ctx,
    orgId,
    bytes,
    {
      sheet: patch.sheet ?? row.sheet ?? undefined,
      recordsPointer: patch.recordsPointer ?? row.recordsPointer ?? undefined,
    },
    await zoneOf(ctx, orgId),
  );
  const summary = summaryOf(file);
  const next: FileRow = {
    ...row,
    sheet: file.sheet,
    recordsPointer: file.recordsPointer,
    columnLabels: file.columns,
    rows: file.records.length,
    columns: file.columns.length,
  };
  await updateDraft(ctx, { orgId, authority }, next, ctx.clock.now());
  await putSummary(ctx, orgId, id, summary);
  return draftDto(next, summary);
}

/** Rows first, objects after: a crash between leaves objects the daily sweep removes. */
export async function discardDraft(
  ctx: ServiceContext,
  actor: Actor,
  authority: ConnectionAuthority,
  id: string,
): Promise<void> {
  const orgId = authority.orgId;
  const row = await getFile(ctx.env.DB, orgId, id);
  if (row?.state !== 'draft') throw new FileNotFoundError();
  await discardFile(ctx, { orgId, authority }, row, ctx.clock.now());
  await deleteFileObjects(ctx, orgId, id);
  await audit(ctx, actor, orgId, 'connection.file_discard', null, row);
}

/** What the create grant needs to turn a draft into revision 1: the pages are written here, before the commit. */
export async function prepareBind(
  ctx: ServiceContext,
  orgId: string,
  fileId: string,
  idColumn: string,
): Promise<Bind> {
  const row = await requireDraft(ctx, orgId, fileId);
  if (!row.columnLabels.some((label) => pointerOf(label) === idColumn))
    throw new FileIdColumnMissingError();
  const bytes = await readSource(ctx, orgId, fileId);
  if (!bytes) throw new FileExpiredError();
  const file = parseFile(
    ctx,
    orgId,
    bytes,
    { sheet: row.sheet ?? undefined, recordsPointer: row.recordsPointer ?? undefined },
    await zoneOf(ctx, orgId),
  );
  const { entries, noId, duplicate } = entriesOf(file.records, idColumn);
  if (entries.length === 0)
    throw new FileIdColumnMissingError('No row has a value in the ID column.');
  const { pages } = await writeRows(ctx, orgId, fileId, entries);
  return {
    fileId,
    idPointer: idColumn,
    pages,
    skippedNoId: noId,
    skippedDuplicate: duplicate,
    now: ctx.clock.now(),
  };
}

/** A stale draft at commit (expired, discarded or bound in the meantime) reads as the state it is in. */
export const staleDraft = (): FileStateError =>
  new FileStateError('The upload changed. Upload the file again.');

/** A draft file rides only on a connector that reads uploads, and such a connector needs one to be created. */
export function assertFileInput(
  def: AnyConnector,
  fileId: string | undefined,
  creating = false,
): void {
  if (fileId !== undefined && !def.capabilities.upload)
    throw new ValidationError('This connector takes no files.', [
      { path: 'fileId', message: 'Not supported.' },
    ]);
  if (creating && fileId === undefined && def.capabilities.upload)
    throw new ValidationError('Upload a file first.', [{ path: 'fileId', message: 'Required.' }]);
}

/** The bind of a create: the draft named by `fileId` and the ID column of the config. Undefined for other connectors. */
export async function bindOf(
  ctx: ServiceContext,
  def: AnyConnector,
  orgId: string,
  fileId: string | undefined,
  config: unknown,
): Promise<Bind | undefined> {
  if (!def.capabilities.upload || fileId === undefined) return undefined;
  const idColumn = (config as { idColumn?: unknown }).idColumn;
  if (typeof idColumn !== 'string') throw new FileIdColumnMissingError();
  return prepareBind(ctx, orgId, fileId, idColumn);
}
