import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [
  'src/shared/copy',
  'src/web',
  'src/worker/email',
  'src/worker/ssr',
  'docs/developers',
  'docs/api/error-guide.json',
];

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

describe('naming', () => {
  it('calls the identity service Polaris ID, never Pocket ID, where people read it', () => {
    const hits = ROOTS.flatMap(files).filter((file) =>
      /Pocket ID/.test(readFileSync(file, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
