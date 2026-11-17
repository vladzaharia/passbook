// After `vite build`: records the commit dist/ was built from. tools/deploy.ts refuses a stale dist/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gitState, stampPath } from './lib/build-stamp.ts';

const root = resolve(import.meta.dirname, '..');
const { head, dirty } = gitState(root);
mkdirSync(dirname(stampPath(root)), { recursive: true });
writeFileSync(stampPath(root), `${JSON.stringify({ sha: head, dirty })}\n`);
