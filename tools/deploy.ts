// Guarded production deploy. Dry run unless --apply.
//   node tools/deploy.ts --check   check wrangler.jsonc only; add --secrets to also check required secret names
//   npm run deploy:check -- <flags>  same
//   npm run deploy                   print the plan
//   npm run deploy -- --apply        run every check, upload a Worker version, bookmark D1, migrate,
//                                    promote the version
//   npm run deploy -- --first --apply  first deploy, or one that adds queue consumers, workflows or
//                                    Durable Object classes: bookmark D1, migrate, then wrangler deploy
// Refuses while wrangler.jsonc still has placeholder ids or keys, or a required secret is unset.
// Migrations are forward-only. Once they run, roll forward; the previous Worker version is an
// emergency degraded mode only (docs/operations.md, Rollback). Never restore D1 to undo a deploy.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deployFlags, missingSecrets, parseVersionId } from './lib/deploy-plan.ts';
import { readJsonc } from './lib/jsonc.ts';
import { parseBookmark, predeployProblems } from './lib/predeploy.ts';

const root = resolve(import.meta.dirname, '..');
const args = deployFlags(process.argv.slice(2), process.env);
const database = 'wallet-platform';

const config = readJsonc(resolve(root, 'wrangler.jsonc')) as Parameters<
  typeof predeployProblems
>[0] & {
  secrets?: { required?: string[] };
};
const problems = predeployProblems(config, {
  allowNoPush: args.has('--allow-no-push'),
  allowNoOidc: args.has('--allow-no-oidc'),
});
if (problems.length > 0) {
  console.error(`Not deploying. Fix wrangler.jsonc:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
const wrangler = (...a: string[]) =>
  execFileSync('npx', ['wrangler', ...a], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const required = config.secrets?.required ?? [];
const checkSecrets = () => {
  const missing = missingSecrets(required, wrangler('secret', 'list', '--format', 'json'));
  if (missing.length > 0) {
    console.error(`Not migrating. Set with wrangler secret put: ${missing.join(', ')}`);
    process.exit(1);
  }
};
if (args.has('--check')) {
  if (args.has('--secrets')) checkSecrets();
  console.log('wrangler.jsonc is ready to deploy.');
  process.exit(0);
}

// `versions upload` cannot create the Worker, apply Durable Object class changes or (as far as
// Cloudflare documents) register queue consumers and workflows; only `wrangler deploy` does.
const first = args.has('--first');
const plan = first
  ? [
      `wrangler secret list   (fails unless all of ${required.join(', ') || 'none'} are set)`,
      `wrangler d1 time-travel info ${database}   (bookmark recorded in .wrangler/d1-bookmarks.log)`,
      `wrangler d1 migrations apply ${database} --remote`,
      'wrangler deploy   (registers queue consumers, workflows and Durable Object classes; serves at once)',
    ]
  : [
      `wrangler secret list   (fails unless all of ${required.join(', ') || 'none'} are set)`,
      'wrangler versions upload   (a new version, not yet serving)',
      `wrangler d1 time-travel info ${database}   (bookmark recorded in .wrangler/d1-bookmarks.log)`,
      `wrangler d1 migrations apply ${database} --remote`,
      'wrangler versions deploy <version>@100%   (promote)',
    ];
if (!args.has('--apply')) {
  console.log(`${plan.join('\n')}\nDry run. Re-run with --apply.`);
  process.exit(0);
}

checkSecrets();

mkdirSync(resolve(root, '.wrangler'), { recursive: true });
const outputFile = resolve(root, '.wrangler/deploy-output.ndjson');
writeFileSync(outputFile, '');
let versionId: string | null = null;
if (!first) {
  const uploaded = execFileSync('npx', ['wrangler', 'versions', 'upload'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  versionId = parseVersionId(readFileSync(outputFile, 'utf8'), uploaded);
  if (!versionId) throw new Error('No version id from wrangler versions upload. Not migrating.');
  console.log(`Uploaded Worker version ${versionId}; previous version keeps serving.`);
}

const bookmark = parseBookmark(wrangler('d1', 'time-travel', 'info', database));
if (!bookmark) throw new Error('No D1 bookmark in the wrangler output. Not migrating.');
appendFileSync(
  resolve(root, '.wrangler/d1-bookmarks.log'),
  `${new Date().toISOString()} ${bookmark}\n`,
);
console.log(
  `D1 bookmark ${bookmark}. Last resort only: a restore drops everything written since, including pass tombstones.`,
);
console.log(wrangler('d1', 'migrations', 'apply', database, '--remote'));
console.log(
  versionId ? wrangler('versions', 'deploy', `${versionId}@100%`, '--yes') : wrangler('deploy'),
);
