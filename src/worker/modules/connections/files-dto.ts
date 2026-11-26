import type { z } from 'zod';
import type {
  ConnectionFileRevisionSchema,
  ConnectionFileSchema,
} from '../../../shared/contracts/connection-files.ts';
import type { FileSummary } from './files-store.ts';
import type { FileRow } from './repo-files.ts';

export type FileDto = z.infer<typeof ConnectionFileSchema>;
export type RevisionDto = z.infer<typeof ConnectionFileRevisionSchema>;

/** The cursor a connector leaves when a run has applied one file to the end. */
export const doneCursor = (fileId: string): string => `fu1:${fileId}:-:done:0`;

export function draftDto(row: FileRow, summary: FileSummary): FileDto {
  return {
    id: row.id,
    orgId: row.orgId,
    state: row.state,
    name: row.name,
    format: row.format,
    sheets: summary.sheets,
    sheet: row.sheet,
    recordsPointer: row.recordsPointer,
    bytes: row.bytes,
    rows: row.rows,
    columns: summary.columns,
    preview: summary.preview,
    idCandidates: summary.idCandidates,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function revisionDto(
  row: FileRow,
  applied: boolean,
  names: ReadonlyMap<string, string>,
): RevisionDto {
  return {
    id: row.id,
    connectionId: row.connectionId ?? '',
    revision: row.revision ?? 1,
    state: row.state,
    name: row.name,
    format: row.format,
    sheet: row.sheet,
    bytes: row.bytes,
    rows: row.rows,
    skipped: { noId: row.skippedNoId ?? 0, duplicate: row.skippedDuplicate ?? 0 },
    diff: row.diff,
    applied,
    createdBy: row.createdBy,
    createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
    expiresAt: row.state === 'pending' ? row.expiresAt : null,
    supersededAt: row.supersededAt,
  };
}
