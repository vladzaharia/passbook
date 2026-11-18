// Key ring tools (owner only). docs/operations.md, KEK rotation.
//   <KEK in base64 on stdin> | node tools/keys.ts mac-root | wrangler secret put MAC_ROOT_V1
//     Prints the MAC root of a KEK (HKDF-Extract, src/worker/platform/mac-roots.ts). It derives every MAC key
//     the KEK does and unwraps no envelope, but it forges every MAC the KEK would: keep and escrow it like the
//     KEK. Never reads .secrets/: pipe the KEK from your vault.
//   npm run keys:retire -- <n>            print what stands in the way of deleting KEK_V<n>
//   npm run keys:retire -- <n> --apply    delete KEK_V<n> when nothing does (reads production with --remote)
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { extractMacRoot } from '../src/worker/platform/mac-roots.ts';
import { readJsonc } from './lib/jsonc.ts';
import { retireChecks } from './lib/retire-key.ts';

const root = resolve(import.meta.dirname, '..');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'mac-root') {
  const kek = await readStdin();
  if (!kek) {
    console.error('Pipe the KEK (base64) on stdin.');
    process.exit(1);
  }
  process.stdout.write(`${await extractMacRoot(kek)}\n`);
} else if (command === 'retire') {
  const apply = rest.includes('--apply');
  const n = Number(rest.find((a) => a !== '--apply'));
  if (!Number.isSafeInteger(n) || n < 1 || rest.some((a) => a !== '--apply' && Number(a) !== n)) {
    console.error('Usage: npm run keys:retire -- <KEK version> [--apply]');
    process.exit(1);
  }
  const config = readJsonc(resolve(root, 'wrangler.jsonc')) as {
    name: string;
    vars?: Record<string, unknown>;
    d1_databases?: { database_name: string }[];
  };
  const database = config.d1_databases?.[0]?.database_name;
  if (!database) throw new Error('wrangler.jsonc has no D1 database.');
  const wrangler = (args: string[], input?: string) =>
    execFileSync('npx', ['wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
    });
  const problems = retireChecks(n, {
    secretList: () => wrangler(['secret', 'list', '--format', 'json']),
    query: (sql) => wrangler(['d1', 'execute', database, '--remote', '--json', '--command', sql]),
    vars: config.vars ?? {},
    now: () => Date.now(),
  });
  if (problems.length > 0) {
    console.error(`KEK_V${n} stays:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  if (!apply) {
    console.log(
      `KEK_V${n} can be deleted. Keep its value in offline escrow, then re-run with --apply.`,
    );
    process.exit(0);
  }
  wrangler(['secret', 'delete', `KEK_V${n}`, '--name', config.name], 'y\n');
  console.log(`Deleted KEK_V${n}. Check Status: keys and kek must be verified.`);
} else {
  console.error(
    'Usage: <KEK base64> | node tools/keys.ts mac-root   |   npm run keys:retire -- <n> [--apply]',
  );
  process.exit(1);
}
