import { describe, expect, it } from 'vitest';
import {
  CONNECTION_FILE_LIMITS,
  ConnectionFileUploadResultSchema,
  JsonPointerSchema,
  UploadConnectionFileSchema,
} from './connection-files.ts';

describe('JsonPointerSchema', () => {
  it.each(['', '/id', '/Member ID', '/a/0/b', '/a~1b', '/m~0n'])('accepts %j', (p) => {
    expect(JsonPointerSchema.safeParse(p).success).toBe(true);
  });
  it.each(['id', 'a/b', '/a~2', '/a~', `/${'x'.repeat(500)}`])('refuses %j', (p) => {
    expect(JsonPointerSchema.safeParse(p).success).toBe(false);
  });
});

describe('UploadConnectionFileSchema', () => {
  const file = { name: 'members.xlsx', encoding: 'base64' as const };
  it('takes base64 of the largest file and refuses one character more', () => {
    const max = Math.ceil(CONNECTION_FILE_LIMITS.bytes / 3) * 4;
    expect(
      UploadConnectionFileSchema.safeParse({ ...file, content: 'A'.repeat(max) }).success,
    ).toBe(true);
    expect(
      UploadConnectionFileSchema.safeParse({ ...file, content: 'A'.repeat(max + 1) }).success,
    ).toBe(false);
  });
  it('refuses an unknown encoding and a bare-name records pointer', () => {
    expect(
      UploadConnectionFileSchema.safeParse({ ...file, content: 'x', encoding: 'utf16' }).success,
    ).toBe(false);
    expect(
      UploadConnectionFileSchema.safeParse({ ...file, content: 'x', recordsPointer: 'data' })
        .success,
    ).toBe(false);
  });
});

describe('ConnectionFileUploadResultSchema', () => {
  it('reads an unchanged upload as just that', () => {
    expect(ConnectionFileUploadResultSchema.parse({ unchanged: true })).toEqual({
      unchanged: true,
    });
  });
  it('needs the revision when something changed', () => {
    expect(ConnectionFileUploadResultSchema.safeParse({ unchanged: false }).success).toBe(false);
  });
});
