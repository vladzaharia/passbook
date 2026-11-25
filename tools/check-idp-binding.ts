// The IDP service binding reaches the Polaris ID (Pocket ID) admin key through the polaris-binding Worker.
// Only its typed client may name it; the same checks as check-apple-binding.ts. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { findBinding } from './check-apple-binding.ts';

const root = resolve(import.meta.dirname, '..');
const ALLOWED = /^src\/worker\/modules\/idp\/client(\.test)?\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

/** Lines naming `.IDP`, `['IDP']`, a destructured `IDP`, or reaching it indirectly. */
export function findIdpBinding(rel: string, text: string): string[] {
  return ALLOWED.test(rel) ? [] : findBinding('IDP', rel, text);
}

if (import.meta.main) {
  const bad = [...sources(join(root, 'src'))].flatMap((f) =>
    findIdpBinding(relative(root, f), readFileSync(f, 'utf8')),
  );
  if (bad.length > 0) {
    process.stderr.write(`env.IDP outside modules/idp/client.ts:\n${bad.join('\n')}\n`);
    process.exit(1);
  }
}
