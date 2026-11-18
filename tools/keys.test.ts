import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { extractMacRoot } from '../src/worker/platform/mac-roots.ts';

const kek = Buffer.alloc(32, 5).toString('base64');

describe('keys mac-root', () => {
  it('prints the extracted root of the KEK on stdin', async () => {
    const out = execFileSync('node', ['tools/keys.ts', 'mac-root'], {
      input: `${kek}\n`,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(await extractMacRoot(kek));
  });

  it('refuses an empty stdin and an unknown command', () => {
    expect(() =>
      execFileSync('node', ['tools/keys.ts', 'mac-root'], { input: '', stdio: 'pipe' }),
    ).toThrow();
    expect(() => execFileSync('node', ['tools/keys.ts', 'nope'], { stdio: 'pipe' })).toThrow();
  });
});

describe('keys retire', () => {
  it('refuses a missing or malformed version before it reads anything', () => {
    for (const args of [['retire'], ['retire', 'x'], ['retire', '0'], ['retire', '1', '2']])
      expect(() => execFileSync('node', ['tools/keys.ts', ...args], { stdio: 'pipe' })).toThrow(
        /Usage/,
      );
  });
});
