// Seeds the apple-provisioner allowlist with the platform pass type ID. Owner only: an agent never runs this.
//   node tools/apple-provisioner-seed.ts               print the command
//   node tools/apple-provisioner-seed.ts --apply       run it against the LOCAL D1
//   node tools/apple-provisioner-seed.ts --apply --remote   run it against production (owner)
// The row has no Apple id yet: the first `findPassType('pass.im.plrs.wallet')` call fills it in.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const IDENTIFIER = 'pass.im.plrs.wallet';
const root = resolve(import.meta.dirname, '..');

export function seedArgs(remote: boolean, at: number): string[] {
  const sql = `INSERT OR IGNORE INTO asc_pass_types (identifier, asc_id, name, source, created_at) VALUES ('${IDENTIFIER}', NULL, NULL, 'seeded', ${at})`;
  return [
    'wrangler',
    'd1',
    'execute',
    'apple-provisioner',
    '--config',
    'workers/apple-provisioner/wrangler.jsonc',
    remote ? '--remote' : '--local',
    '--command',
    sql,
  ];
}

if (import.meta.main) {
  const flags = new Set(process.argv.slice(2));
  const args = seedArgs(flags.has('--remote'), Date.now());
  console.log(`npx ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  if (!flags.has('--apply')) {
    console.log('Dry run. Re-run with --apply to execute.');
    process.exit(0);
  }
  execFileSync('npx', args, { cwd: root, stdio: 'inherit' });
}
