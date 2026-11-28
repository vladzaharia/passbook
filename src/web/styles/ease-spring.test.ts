import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('wallet.css sets the ok hop and attract wave spring', () => {
  const css = readFileSync(join(process.cwd(), 'src/web/styles/wallet.css'), 'utf8');
  expect(css).toMatch(/--pk-ease-spring:\s*cubic-bezier\(0\.34, 1\.56, 0\.64, 1\);/);
});
