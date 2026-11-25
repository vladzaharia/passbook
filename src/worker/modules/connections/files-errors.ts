import { TabularError, type TabularErrorCode } from '../../../shared/tabular/index.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A file the parser refused: the code is the parser's, the status follows it. Messages carry no file content. */
export class FileRejectedError extends AppError {
  constructor(code: TabularErrorCode, message: string) {
    super(code, statusOf(code), message);
  }
}

const statusOf = (code: TabularErrorCode): number =>
  code === 'FILE_TOO_LARGE'
    ? 413
    : code === 'FILE_BAD_POINTER' || code === 'FILE_SHEET_NOT_FOUND'
      ? 400
      : 422;

export class FileIdColumnMissingError extends AppError {
  constructor(message = 'The ID column is not in the file.') {
    super('FILE_ID_COLUMN_MISSING', 422, message);
  }
}
export class FileExpiredError extends AppError {
  constructor(message = 'The upload expired. Upload the file again.') {
    super('FILE_EXPIRED', 410, message);
  }
}
export class FileStateError extends AppError {
  constructor(message = 'The file is not in a state that allows this.') {
    super('FILE_STATE', 409, message);
  }
}
export class FileNotFoundError extends AppError {
  constructor() {
    super('FILE_NOT_FOUND', 404, 'File not found.');
  }
}

/**
 * Maps a parser failure to a response. A catch-all `FILE_DAMAGED` that wraps an unexpected exception logs that
 * exception's name beside the code, so a parser bug stays visible; the message and the file never reach a log.
 */
export function rejectFile(ctx: ServiceContext, orgId: string, error: unknown): never {
  if (error instanceof TabularError) {
    const inner = error.cause instanceof Error ? error.cause.name : undefined;
    if (inner !== undefined)
      ctx.log.error('connection_file.parse_failed', {
        orgId,
        code: error.code,
        errorName: inner,
      });
    throw new FileRejectedError(error.code, error.message);
  }
  ctx.log.error('connection_file.parse_failed', {
    orgId,
    code: 'FILE_DAMAGED',
    errorName: error instanceof Error ? error.name : typeof error,
  });
  throw new FileRejectedError('FILE_DAMAGED', 'The file could not be read.');
}
