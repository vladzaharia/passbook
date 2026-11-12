// Cutover bootstrap: gives a named owner org_admin in every org, pins every active uploaded template
// to a legacy release at its current active version, and binds queued pass emails to their pass. Dry run unless --apply; --apply writes the
// local D1 only. Production is applied by the owner with the printed wrangler commands.
//   node tools/bootstrap-tenancy.ts --owner you@example.com [--persist-to .wrangler/state]
//   node tools/bootstrap-tenancy.ts --owner you@example.com --apply
//   --config <wrangler.jsonc> picks another local database (tests, scratch copies).
//   node tools/bootstrap-tenancy.ts --owner you@example.com --print-remote   only the production commands
//   node tools/bootstrap-tenancy.ts --owner you@example.com --snapshot .wrangler/bootstrap-snapshot.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strictEmail } from '../src/shared/email.ts';
import {
  BOOTSTRAP_SQL,
  type BootstrapSnapshot,
  buildBootstrap,
  remoteCommands,
  SNAPSHOT_SQL,
  snapshotSql,
} from './lib/bootstrap-tenancy.ts';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const database = 'wallet-platform';
const sqlFile = resolve(root, BOOTSTRAP_SQL);

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
  return {
    owner: raw.owner ?? null,
    orgs: raw.orgs ?? [],
    templates: raw.templates ?? [],
    emails: raw.emails ?? [],
    bundleEmails: raw.bundleEmails ?? [],
  };
}

function printRemote(): void {
  mkdirSync(resolve(root, '.wrangler'), { recursive: true });
  writeFileSync(resolve(root, SNAPSHOT_SQL), snapshotSql(owner as string));
  console.log(
    `Production, run by the owner after the migrations are applied and before the new Worker is promoted:\n${remoteCommands(
      owner as string,
      database,
    )
      .map((c) => `  ${c}`)
      .join('\n')}`,
  );
}
if (flag('--print-remote')) {
  printRemote();
  process.exit(0);
}

const snapshotPath = value('--snapshot');
const snapshot = parseSnapshot(
  snapshotPath
    ? readFileSync(resolve(root, snapshotPath), 'utf8')
    : wranglerLocal('--json', '--command', snapshotSql(owner)),
);
const { plan, sql } = await buildBootstrap(snapshot, owner, Date.now());
// The snapshot carries download tokens (hashed into the SQL, never written to it); do not keep it.
if (snapshotPath) rmSync(resolve(root, snapshotPath), { force: true });
mkdirSync(resolve(root, '.wrangler'), { recursive: true });
writeFileSync(sqlFile, sql);

console.log(
  `${plan.map((line) => `- ${line}`).join('\n') || '- nothing to do'}\nSQL: ${BOOTSTRAP_SQL}`,
);
if (snapshotPath && !flag('--apply')) {
  console.log(`Next, production:\n  ${remoteCommands(owner, database)[2]}`);
  process.exit(0);
}
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
printRemote();
