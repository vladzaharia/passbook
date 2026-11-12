// Creates the Cloudflare resources the Worker needs and retires legacy secrets. Dry run unless --apply.
//   node tools/provision.ts            print the wrangler commands
//   node tools/provision.ts --apply    run them (owner only; touches the real account)
// Safe to rerun: each step probes first and is skipped when the resource already exists.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonc } from './lib/jsonc.ts';
import { buildSteps, namesFrom, provision } from './lib/provision.ts';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'wrangler.jsonc');
const names = namesFrom(readJsonc(file));
const unknown = process.argv.slice(2).filter((a) => a !== '--apply');
if (unknown.length > 0) throw new Error(`Unexpected argument ${unknown[0]}.`);

if (!process.argv.includes('--apply')) {
  for (const step of buildSteps(names)) {
    console.log(`# ${step.title}${step.probe ? ' (probed first)' : ''}`);
    console.log(`npx wrangler ${step.args.join(' ')}`);
  }
  console.log(`# wrangler.jsonc: write the ${names.database} id to d1_databases[0].database_id`);
  console.log('Dry run. Re-run with --apply to execute.');
  process.exit(0);
}

provision({
  names,
  run: (args, input) =>
    execFileSync('npx', ['wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      ...(input ? { input } : {}),
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'],
    }),
  readConfig: () => readFileSync(file, 'utf8'),
  writeConfig: (text) => writeFileSync(file, text),
  log: console.log,
});
console.log('Done. Run npm run gen, then npm run deploy:check.');
