import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('RL_API_KEY policy', () => {
  it('matches the limit and window rate-limit.ts reports in headers', () => {
    const wrangler = read('wrangler.jsonc');
    const entry =
      /"name":\s*"RL_API_KEY"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(
        wrangler,
      );
    const source = read('src/worker/platform/rate-limit.ts');
    const limit = /API_KEY_LIMIT = (\d+)/.exec(source)?.[1];
    const window = /WINDOW_SECONDS = (\d+)/.exec(source)?.[1];
    expect(entry).not.toBeNull();
    expect(Number(entry?.[1])).toBe(Number(limit));
    expect(Number(entry?.[2])).toBe(Number(window));
  });
});
