import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Connectors reach the platform only through their context: no repo, D1, R2, queue or Worker env. */
const ALLOWED = [
  /^\/src\/worker\/connectors\//,
  /^\/src\/shared\//,
  /^\/src\/generated\/connectors\.ts$/,
  /^\/src\/worker\/platform\/(?:safe-fetch|read-capped|ids|errors)\.ts$/,
];
const PACKAGES = new Set(['zod']);

function outsideImports(file: string, text: string): string[] {
  const base = `file:///src/worker/connectors/${file.slice(2)}`;
  return [...text.matchAll(/\bfrom '([^']+)'|\bimport\('([^']+)'\)/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .filter((spec) =>
      spec.startsWith('.')
        ? !ALLOWED.some((re) => re.test(new URL(spec, base).pathname))
        : !PACKAGES.has(spec),
    )
    .map((spec) => `${file}: ${spec}`);
}

describe('connector port boundary', () => {
  it('reads the connector sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it('imports nothing beyond the context, shared code and safe-fetch', () => {
    expect(Object.entries(sources).flatMap(([file, text]) => outsideImports(file, text))).toEqual(
      [],
    );
  });

  it('names no binding and reads no Worker env', () => {
    const leaks = Object.entries(sources)
      .filter(([, text]) => /\b(?:D1Database|R2Bucket|KVNamespace|Queue<)|\benv\.[A-Z]/.test(text))
      .map(([file]) => file);
    expect(leaks).toEqual([]);
  });
});
