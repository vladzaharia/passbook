import { CONNECTION_FILE_LIMITS } from '@/shared/contracts/connection-files.ts';
import { ApiError, errorMessage } from '../../../lib/errors.ts';

export type UploadFailureKind = 'rate' | 'large' | 'bad' | 'other';

export interface UploadFailure {
  kind: UploadFailureKind;
  text: string;
}

const MB = CONNECTION_FILE_LIMITS.bytes / 1024 / 1024;
export const TOO_LARGE = `Over ${MB} MB. Remove columns or split the file.`;

/** A file the browser can see is too big before it is sent. */
export const tooLarge = (): UploadFailure => ({ kind: 'large', text: TOO_LARGE });

/** One sentence per refusal: the hourly allowance, the size cap, or a file the parser could not read. */
export function uploadFailure(error: unknown): UploadFailure {
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === 'RATE_LIMITED') {
      const min = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60));
      return { kind: 'rate', text: `Too many uploads this hour. Try again in ${min} min.` };
    }
    if (error.status === 413 || error.code === 'FILE_TOO_LARGE') return tooLarge();
    if (error.code.startsWith('FILE_')) return { kind: 'bad', text: error.message };
  }
  return { kind: 'other', text: errorMessage(error) };
}
