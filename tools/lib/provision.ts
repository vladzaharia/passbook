import { setJsonc } from './jsonc.ts';

export const LEGACY_SECRETS = [
  'ADMIN_TOKEN',
  'SIGNER_HENRYS_CERTIFICATE',
  'SIGNER_HENRYS_PRIVATE_KEY',
];
export const LIFECYCLE_RULE = 'expire-uploads';
export const LIFECYCLE_PREFIX = 'uploads/';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

export interface WranglerNames {
  worker: string;
  database: string;
  queues: string[];
  bucket: string;
}

interface WranglerShape {
  name: string;
  d1_databases?: { database_name: string }[];
  queues?: { producers?: { queue: string }[] };
  r2_buckets?: { bucket_name: string }[];
}

/** Resource names come from wrangler.jsonc so the script cannot drift from the bindings. */
export function namesFrom(config: WranglerShape): WranglerNames {
  const database = config.d1_databases?.[0]?.database_name;
  const bucket = config.r2_buckets?.[0]?.bucket_name;
  if (!database || !bucket) throw new Error('wrangler.jsonc has no D1 database or R2 bucket.');
  return {
    worker: config.name,
    database,
    queues: (config.queues?.producers ?? []).map((p) => p.queue),
    bucket,
  };
}

export interface Step {
  title: string;
  /** Read-only probe; the step is skipped when `done` accepts its output. */
  probe?: { args: string[]; done: (output: string) => boolean };
  args: string[];
  /** Text fed to stdin (confirmation prompts). */
  input?: string;
}

const hasWord = (output: string, name: string) =>
  new RegExp(`(^|[^A-Za-z0-9_-])${name}($|[^A-Za-z0-9_-])`, 'm').test(output);

export function buildSteps(n: WranglerNames): Step[] {
  return [
    {
      title: `D1 ${n.database}`,
      probe: { args: ['d1', 'list', '--json'], done: (o) => o.includes(`"${n.database}"`) },
      args: ['d1', 'create', n.database],
    },
    ...n.queues.map(
      (queue): Step => ({
        title: `Queue ${queue}`,
        probe: { args: ['queues', 'list'], done: (o) => hasWord(o, queue) },
        args: ['queues', 'create', queue],
      }),
    ),
    {
      title: `R2 bucket ${n.bucket}`,
      probe: { args: ['r2', 'bucket', 'list'], done: (o) => hasWord(o, n.bucket) },
      args: ['r2', 'bucket', 'create', n.bucket],
    },
    {
      title: `R2 lifecycle ${LIFECYCLE_PREFIX} (1 day)`,
      probe: {
        args: ['r2', 'bucket', 'lifecycle', 'list', n.bucket],
        done: (o) => hasWord(o, LIFECYCLE_RULE),
      },
      args: [
        'r2',
        'bucket',
        'lifecycle',
        'add',
        n.bucket,
        LIFECYCLE_RULE,
        LIFECYCLE_PREFIX,
        '--expire-days',
        '1',
      ],
    },
    ...LEGACY_SECRETS.map(
      (name): Step => ({
        title: `Delete legacy secret ${name}`,
        probe: {
          args: ['secret', 'list', '--name', n.worker, '--format', 'json'],
          // Done (nothing to delete) when the secret is absent.
          done: (o) => !o.includes(`"${name}"`),
        },
        args: ['secret', 'delete', name, '--name', n.worker],
        input: 'y\n',
      }),
    ),
  ];
}

/** The D1 id for `database` in `wrangler d1 list --json` output, or null. */
export function findDatabaseId(listJson: string, database: string): string | null {
  const rows = JSON.parse(listJson) as { name: string; uuid: string }[];
  return rows.find((r) => r.name === database)?.uuid ?? null;
}

export function withDatabaseId(config: string, id: string): string {
  return setJsonc(config, ['d1_databases', 0, 'database_id'], id);
}

export const isPlaceholderId = (id: string | undefined) => !id || id === ZERO_ID;

export type Runner = (args: string[], input?: string) => string;

export interface ProvisionResult {
  ran: string[];
  skipped: string[];
  databaseId: string | null;
}

/** Runs the steps in order; each probe makes a rerun safe. Writes the D1 id back to the config. */
export function provision(opts: {
  names: WranglerNames;
  run: Runner;
  readConfig: () => string;
  writeConfig: (text: string) => void;
  log: (line: string) => void;
}): ProvisionResult {
  const { names, run, log } = opts;
  const result: ProvisionResult = { ran: [], skipped: [], databaseId: null };
  for (const step of buildSteps(names)) {
    if (step.probe?.done(run(step.probe.args))) {
      result.skipped.push(step.title);
      log(`skip  ${step.title}`);
      continue;
    }
    log(`run   ${step.title}`);
    run(step.args, step.input);
    result.ran.push(step.title);
  }
  const id = findDatabaseId(run(['d1', 'list', '--json']), names.database);
  if (!id) throw new Error(`D1 ${names.database} not found after create.`);
  result.databaseId = id;
  const before = opts.readConfig();
  const after = withDatabaseId(before, id);
  if (after !== before) opts.writeConfig(after);
  log(`wrangler.jsonc: d1_databases[0].database_id = ${id}`);
  return result;
}
