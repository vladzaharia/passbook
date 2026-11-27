// First deploy of workers/passbook-id-connector. Owner only: an agent never runs this (it uses --remote and deploys).
//   npm run binding:first-deploy
// Needs POCKET_ID_API_KEY in the environment (the passbook-polaris-binding profile) and a Cloudflare
// sign-in: `npx wrangler login`, or CLOUDFLARE_API_TOKEN (wrangler reads it itself). The config pins the account. Creates the D1 only when absent, writes its id into the binding's
// wrangler.jsonc, applies migrations, puts the key over stdin and deploys. Safe to run again.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG = 'workers/passbook-id-connector/wrangler.jsonc';
const DB_NAME = 'passbook-id-connector';

export type Wrangler = (args: string[], stdin?: string) => { status: number; stdout: string };
export interface Deps {
  root: string;
  env: Record<string, string | undefined>;
  wrangler: Wrangler;
  log: (line: string) => void;
}

function fail(step: string, out: { status: number }): never {
  throw new Error(
    `${step} failed (wrangler exit ${out.status}). Fix it and run again; finished steps are skipped.`,
  );
}

export function firstDeploy(deps: Deps): void {
  const { root, env, wrangler, log } = deps;
  const key = env.POCKET_ID_API_KEY;
  if (!key) {
    throw new Error(
      'Missing POCKET_ID_API_KEY. Run this with the passbook-polaris-binding profile.',
    );
  }
  const configFile = resolve(root, CONFIG);

  if (wrangler(['whoami']).status !== 0) {
    throw new Error(
      'Not signed in to Cloudflare: run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN',
    );
  }

  const list = wrangler(['d1', 'list', '--json']);
  if (list.status !== 0) fail('D1 list', list);
  const find = (out: string): string | undefined =>
    (JSON.parse(out) as { uuid: string; name: string }[]).find((d) => d.name === DB_NAME)?.uuid;
  let id = find(list.stdout);
  if (id) {
    log(`D1 ${DB_NAME} exists, reusing it`);
  } else {
    const created = wrangler(['d1', 'create', DB_NAME]);
    if (created.status !== 0) fail('D1 create', created);
    const again = wrangler(['d1', 'list', '--json']);
    id = again.status === 0 ? find(again.stdout) : undefined;
    if (!id) throw new Error(`D1 ${DB_NAME} was created but is not listed. Run this again.`);
    log(`D1 ${DB_NAME} created`);
  }

  const text = readFileSync(configFile, 'utf8');
  const next = text.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
  if (next === text) {
    log(`${CONFIG} already holds the D1 id`);
  } else {
    writeFileSync(configFile, next);
    log(`${CONFIG} now holds the D1 id: commit it`);
  }

  const migrate = wrangler(['d1', 'migrations', 'apply', DB_NAME, '--config', CONFIG, '--remote']);
  if (migrate.status !== 0) fail('Migrations', migrate);
  log('Migrations applied');

  const secret = wrangler(['secret', 'put', 'POCKET_ID_API_KEY', '--config', CONFIG], key);
  if (secret.status !== 0) fail('Secret', secret);
  log('POCKET_ID_API_KEY set');

  const deploy = wrangler(['deploy', '--config', CONFIG]);
  if (deploy.status !== 0) fail('Deploy', deploy);
  log('passbook-id-connector deployed');
}

if (import.meta.main) {
  const key = process.env.POCKET_ID_API_KEY ?? '';
  const root = resolve(import.meta.dirname, '..');
  // Output is captured so the key can never reach the terminal, even in a wrangler error.
  const wrangler: Wrangler = (args, stdin) => {
    const run = spawnSync('npx', ['wrangler', ...args], {
      cwd: root,
      input: stdin,
      encoding: 'utf8',
    });
    return {
      status: run.status ?? 1,
      stdout: key ? run.stdout.replaceAll(key, '***') : run.stdout,
    };
  };
  try {
    firstDeploy({ root, env: process.env, wrangler, log: (line) => console.log(line) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'Failed.');
    process.exit(1);
  }
}
