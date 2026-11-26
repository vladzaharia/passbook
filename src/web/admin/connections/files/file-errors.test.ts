import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/errors.ts';
import { TOO_LARGE, uploadFailure } from './file-errors.ts';

const fail = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, detail: 'The file has no header row.', ...extra });

describe('uploadFailure', () => {
  it('says when to try again after the hourly allowance', () => {
    expect(uploadFailure(fail(429, 'RATE_LIMITED', { retryAfter: 1500 }))).toEqual({
      kind: 'rate',
      text: 'Too many uploads this hour. Try again in 25 min.',
    });
    expect(uploadFailure(fail(429, 'RATE_LIMITED')).text).toMatch(/in 1 min/);
  });

  it('names the size cap', () => {
    expect(uploadFailure(fail(413, 'FILE_TOO_LARGE'))).toEqual({ kind: 'large', text: TOO_LARGE });
    expect(TOO_LARGE).toMatch(/5 MB/);
  });

  it('passes the parser sentence for a file it cannot read', () => {
    expect(uploadFailure(fail(422, 'FILE_HEADER_MISSING'))).toEqual({
      kind: 'bad',
      text: 'The file has no header row.',
    });
  });

  it('leaves other failures to the shared message', () => {
    expect(uploadFailure(fail(500, 'server_error')).kind).toBe('other');
    expect(uploadFailure(new Error('x')).kind).toBe('other');
  });
});
