// Cutover bootstrap: gives a named owner org_admin in every org and pins every uploaded template
// to a legacy release at its current active version. Dry run unless --apply; --apply writes the
// local D1 only. Production is applied by the owner with the printed wrangler commands.
//   node tools/bootstrap-tenancy.ts --owner you@example.com [--persist-to .wrangler/state]
//   node tools/bootstrap-tenancy.ts --owner you@example.com --apply
//   --config <wrangler.jsonc> picks another local database (tests, scratch copies).
//   node tools/bootstrap-tenancy.ts --owner you@example.com --snapshot .wrangler/bootstrap-snapshot.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strictEmail } from '../src/shared/email.ts';
import { type BootstrapSnapshot, buildBootstrap, snapshotSql } from './lib/bootstrap-tenancy.ts';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const database = 'wallet-platform';
const sqlFile = resolve(root, '.wrangler/bootstrap-tenancy.sql');
const snapshotFile = '.wrangler/bootstrap-snapshot.json';

if (flag('--remote')) {
  console.error('This tool never touches production. Use the commands it prints.');
  process.exit(1);
}
const owner = strictEmail(value('--owner'));
if (!owner) {
  console.error('Pass --owner <email>: the user who becomes org_admin everywhere.');
  process.exit(1);
}
const persist = resolve(root, value('--persist-to') ?? '.wrangler/state');
const config = value('--config');

function wranglerLocal(...a: string[]): string {
  return execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      database,
      '--local',
      '--persist-to',
      persist,
      ...(config ? ['--config', resolve(root, config)] : []),
      ...a,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 },
  );
}

/** wrangler --json prints [{ results: [{ snapshot: "<json>" }] }]. */
function parseSnapshot(output: string): BootstrapSnapshot {
  const parsed: unknown = JSON.parse(output);
  const text = (parsed as { results?: { snapshot?: string }[] }[])[0]?.results?.[0]?.snapshot;
  if (typeof text !== 'string') throw new Error('No snapshot in the wrangler output.');
  const raw = JSON.parse(text) as Partial<BootstrapSnapshot>;
  return { owner: raw.owner ?? null, orgs: raw.orgs ?? [], templates: raw.templates ?? [] };
}

const snapshotPath = value('--snapshot');
const snapshot = parseSnapshot(
  snapshotPath
    ? readFileSync(resolve(root, snapshotPath), 'utf8')
    : wranglerLocal('--json', '--command', snapshotSql(owner)),
);
const { plan, sql } = await buildBootstrap(snapshot, owner, Date.now());
mkdirSync(resolve(root, '.wrangler'), { recursive: true });
writeFileSync(sqlFile, sql);

console.log(
  `${plan.map((line) => `- ${line}`).join('\n') || '- nothing to do'}\nSQL: .wrangler/bootstrap-tenancy.sql`,
);
if (flag('--apply')) {
  if (snapshotPath) {
    console.error('--apply writes the local D1 and reads it fresh; drop --snapshot.');
    process.exit(1);
  }
  wranglerLocal('--file', sqlFile);
  console.log('Applied to the local D1.');
} else {
  console.log('Dry run. Re-run with --apply for the local D1.');
}
console.log(`Production, run by the owner after the migrations are applied:
  npx wrangler d1 execute ${database} --remote --json --command "${snapshotSql(owner).replace(/\s+/g, ' ')}" > ${snapshotFile}
  node tools/bootstrap-tenancy.ts --owner ${owner} --snapshot ${snapshotFile}
  npx wrangler d1 execute ${database} --remote --file .wrangler/bootstrap-tenancy.sql`);
