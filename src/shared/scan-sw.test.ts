import { describe, expect, it } from 'vitest';
import { SCAN_SHELL_CACHE, scanSwSource } from './scan-sw.ts';

describe('scan shell worker', () => {
  const source = scanSwSource('build-7');

  it('is valid script, versioned by build', () => {
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain(`${SCAN_SHELL_CACHE}build-7`);
  });

  it('touches only the document, hashed files and the manifest: never /api, never a non-GET', () => {
    expect(source).not.toContain('/api');
    expect(source).toContain("req.method !== 'GET'");
    expect(source).toContain("startsWith('/assets/')");
    expect(source).not.toContain('skipWaiting');
  });

  it('keeps only whole 200 answers', () => {
    expect(source).toContain('res.status === 200 && !res.redirected');
  });
});
