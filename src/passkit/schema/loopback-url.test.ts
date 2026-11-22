import { describe, expect, it } from 'vitest';
import { has, run } from './rules-helpers.ts';
import { isLoopbackUrl } from './util.ts';

const warns = (url: string) =>
  has(
    run('generic', (p) => {
      p.webServiceURL = url;
    }),
    'warning',
    'URL_SCHEME',
  );

describe('http web service URL', () => {
  it('recognises a dev server', () => {
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1:8787/x',
      'http://127.1.2.3',
      'http://[::1]:3000',
      'http://app.localhost',
    ])
      expect(isLoopbackUrl(new URL(url)), url).toBe(true);
    for (const url of ['http://example.com', 'http://localhost.example.com', 'http://128.0.0.1'])
      expect(isLoopbackUrl(new URL(url)), url).toBe(false);
  });

  it('does not warn on loopback and still warns elsewhere', () => {
    expect(warns('http://localhost:5173/v1')).toBe(false);
    expect(warns('http://127.0.0.1:8787')).toBe(false);
    expect(warns('http://x.example')).toBe(true);
    expect(warns('https://x.example')).toBe(false);
  });
});
