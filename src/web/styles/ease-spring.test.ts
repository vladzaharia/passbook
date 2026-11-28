import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = () => readFileSync(join(process.cwd(), 'src/web/styles/wallet.css'), 'utf8');

it('wallet.css gives the ok hop and attract wave their own curve', () => {
  expect(css()).toMatch(/--wl-ease-hop:\s*cubic-bezier\(0\.34, 1\.56, 0\.64, 1\);/);
});

it('wallet.css leaves the shared pk spring alone', () => {
  expect(css()).not.toMatch(/--pk-ease-spring\s*:/);
});
