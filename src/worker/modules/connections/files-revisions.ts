import type { z } from 'zod';
import type {
  ApplyConnectionFileResponseSchema,
  ConnectionFileRevisionListSchema,
  ConnectionFileUploadResultSchema,
  UploadConnectionFileSchema,
} from '../../../shared/contracts/connection-files.ts';
import type { Actor } from '../../platform/context.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { diffRefs } from './files-diff.ts';
import { doneCursor, revisionDto } from './files-dto.ts';
import {
  FileExpiredError,
  FileIdColumnMissingError,
  FileNotFoundError,
  FileStateError,
} from './files-errors.ts';
import { entriesOf, parseFile, pointerOf, sha256Hex } from './files-parse.ts';
import { auditFile, bytesOf, rowOf, takeUpload, zoneOf } from './files-service.ts';
import { deleteFileObjects, putSource, readRefs, writeRows } from './files-store.ts';
import {
  cursorOf,
  type FileRow,
  fileInState,
  getFile,
  listRevisions,
  nextRevision,
  userNames,
} from './repo-files.ts';
import { discardFile, insertPending, promotePending } from './repo-files-writes.ts';
import { auditActor, requireConnection } from './service-shared.ts';
import { requireConnector } from './validate.ts';

type Upload = z.infer<typeof UploadConnectionFileSchema>;
type UploadResult = z.infer<typeof ConnectionFileUploadResultSchema>;
type RevisionList = z.infer<typeof ConnectionFileRevisionListSchema>;
type Applied = z.infer<typeof ApplyConnectionFileResponseSchema>;

/** The connection, in the caller's org, of a connector that takes files. */
async function requireUploadConnection(
  ctx: ServiceContext,
  authority: ConnectionAuthority,
  id: string,
) {
  const conn = await requireConnection(ctx, id);
  if (conn.orgId !== authority.orgId) throw new ForbiddenError();
  if (!requireConnector(conn.connectorType).capabilities.upload)
    throw new ValidationError('This connection takes no files.');
  return conn;
}

async function dtoOf(ctx: ServiceContext, row: FileRow, applied = false) {
  const names = await userNames(ctx.env.DB, row.createdBy ? [row.createdBy] : []);
  return revisionDto(row, applied, names);
}

/** A new revision, `pending` until applied. Bytes equal to the current revision's create nothing. */
export async function uploadRevision(
  ctx: ServiceContext,
  actor: Actor,
  authority: ConnectionAuthority,
  connectionId: string,
  body: Upload,
  apply: boolean,
): Promise<UploadResult> {
  const conn = await requireUploadConnection(ctx, authority, connectionId);
  const orgId = conn.orgId;
  await takeUpload(ctx, orgId);
  const bytes = bytesOf(ctx, orgId, body);
  const sha = await sha256Hex(bytes);
  const current = await fileInState(ctx.env.DB, orgId, connectionId, 'current');
  if (current?.sha256 === sha) return { unchanged: true };
  const idPointer = (conn.config as { idColumn?: unknown }).idColumn;
  if (typeof idPointer !== 'string') throw new FileIdColumnMissingError();
  const file = parseFile(
    ctx,
    orgId,
    bytes,
    {
      sheet: body.sheet ?? current?.sheet ?? undefined,
      recordsPointer: body.recordsPointer ?? current?.recordsPointer ?? undefined,
    },
    await zoneOf(ctx, orgId),
  );
  if (!file.columns.some((label) => pointerOf(label) === idPointer))
    throw new FileIdColumnMissingError();
  const { entries, noId, duplicate } = entriesOf(file.records, idPointer);
  if (entries.length === 0)
    throw new FileIdColumnMissingError('No row has a value in the ID column.');
  const now = ctx.clock.now();
  const older = await fileInState(ctx.env.DB, orgId, connectionId, 'pending');
  const row = {
    ...rowOf(ctx.ids.id(), orgId, 'pending', body.name, bytes, sha, file, actor.id, now),
    connectionId,
    revision: await nextRevision(ctx.env.DB, orgId, connectionId),
    idPointer,
    skippedNoId: noId,
    skippedDuplicate: duplicate,
  };
  try {
    await putSource(ctx, orgId, row.id, bytes);
    const { pages, refs } = await writeRows(ctx, orgId, row.id, entries);
    row.pages = pages;
    const before = current ? ((await readRefs(ctx, orgId, current.id)) ?? []) : [];
    row.diff = current ? diffRefs(before, refs) : null;
    await insertPending(ctx, { orgId, authority }, connectionId, row, now);
  } catch (error) {
    await deleteFileObjects(ctx, orgId, row.id).catch(() => undefined);
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError('Another upload landed first. Try again.', 'FILE_STATE');
    throw error;
  }
  if (older) await deleteFileObjects(ctx, orgId, older.id);
  await auditFile(ctx, actor, orgId, 'connection.file_upload', connectionId, row);
  if (!apply) return { unchanged: false, ...(await dtoOf(ctx, row)) };
  const applied = await applyRevision(ctx, actor, authority, connectionId, row.id);
  return { unchanged: false, ...applied.file, runId: applied.runId };
}

/** Revisions, newest first. `applied` follows the cursor the connector left. */
export async function listFiles(
  ctx: ServiceContext,
  authority: ConnectionAuthority,
  connectionId: string,
): Promise<RevisionList> {
  const conn = await requireUploadConnection(ctx, authority, connectionId);
  const [rows, cursor] = await Promise.all([
    listRevisions(ctx.env.DB, conn.orgId, connectionId),
    cursorOf(ctx.env.DB, conn.orgId, connectionId),
  ]);
  const names = await userNames(ctx.env.DB, [
    ...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : []))),
  ]);
  return {
    items: rows.map((r) => revisionDto(r, cursor === doneCursor(r.id), names)),
    nextCursor: null,
  };
}

/** The pending revision becomes current and the old current is superseded in one batch; then a sync starts. */
export async function applyRevision(
  ctx: ServiceContext,
  actor: Actor,
  authority: ConnectionAuthority,
  connectionId: string,
  fileId: string,
): Promise<Applied> {
  const conn = await requireUploadConnection(ctx, authority, connectionId);
  const row = await getFile(ctx.env.DB, conn.orgId, fileId);
  if (!row || row.connectionId !== connectionId) throw new FileNotFoundError();
  if (row.state !== 'pending') throw new FileStateError('Only a pending revision can be applied.');
  if ((row.expiresAt ?? 0) <= ctx.clock.now()) throw new FileExpiredError();
  if (!conn.enabled) throw new ConflictError('The connection is disabled.', 'CONNECTION_DISABLED');
  try {
    await promotePending(ctx, { orgId: conn.orgId, authority }, connectionId, row, ctx.clock.now());
  } catch (error) {
    if (error instanceof ConflictError)
      throw new FileStateError('The revision changed. Reload and retry.');
    throw error;
  }
  await recordAudit(ctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.file_apply',
    targetType: 'connection',
    targetId: connectionId,
    detail: { fileId, format: row.format, rows: row.rows, bytes: row.bytes },
  });
  const started = await actions.syncNow(ctx, actor, connectionId, authority);
  const fresh = (await getFile(ctx.env.DB, conn.orgId, fileId)) ?? row;
  return { file: await dtoOf(ctx, fresh), ...started };
}

/** Throws a pending revision away; the connection keeps its current one. */
export async function discardRevision(
  ctx: ServiceContext,
  actor: Actor,
  authority: ConnectionAuthority,
  connectionId: string,
  fileId: string,
): Promise<void> {
  const conn = await requireUploadConnection(ctx, authority, connectionId);
  const row = await getFile(ctx.env.DB, conn.orgId, fileId);
  if (!row || row.connectionId !== connectionId) throw new FileNotFoundError();
  if (row.state !== 'pending')
    throw new FileStateError('Only a pending revision can be discarded.');
  await discardFile(ctx, { orgId: conn.orgId, authority }, row, ctx.clock.now());
  await deleteFileObjects(ctx, conn.orgId, fileId);
  await auditFile(ctx, actor, conn.orgId, 'connection.file_discard', connectionId, row);
}
