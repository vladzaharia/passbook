// Fails when a migration that exists on the base ref was edited or deleted. Production applies each
// migration once by name, so an in-place edit never reaches it. Run in `npm run check:rules`.
// Base: $MIGRATIONS_BASE, else $OPENAPI_BASE, else origin/main. Without that ref (shallow clone) it is skipped.
// Also fails when the wallet release the migrations leave differs from RELEASE (release.ts); that check needs no ref.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RELEASE } from '../src/worker/modules/wallet-providers/release.ts';
import { showAt } from './lib/git-show.ts';
import { frozenFailures } from './lib/migrations-frozen.ts';
import { releaseMirrorProblems } from './lib/wallet-release-sql.ts';

const root = resolve(import.meta.dirname, '..');
const ref = process.env.MIGRATIONS_BASE ?? process.env.OPENAPI_BASE ?? 'origin/main';

const mirror = releaseMirrorProblems(
  readdirSync(resolve(root, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(resolve(root, 'migrations', name), 'utf8') })),
  RELEASE,
);
if (mirror.length > 0) {
  console.error(`check-migrations: the wallet release is out of step:`);
  for (const p of mirror) console.error(`  ${p}`);
  process.exit(1);
}

function baseFiles(): string[] | null {
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', `${ref}:migrations`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => `migrations/${f}`);
  } catch {
    return null;
  }
}

const files = baseFiles();
if (files === null) {
  console.log(`check-migrations: ${ref} not available, skipped`);
} else {
  const base = new Map<string, string>();
  for (const file of files) {
    const text = showAt(root, ref, file);
    if (text !== null) base.set(file, text);
  }
  const failures = frozenFailures({
    base,
    read: (file) => {
      const path = resolve(root, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
  });
  if (failures.length > 0) {
    console.error(`check-migrations: ${failures.length} failure(s) against ${ref}:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`check-migrations: ${base.size} migrations unchanged against ${ref}`);
}
