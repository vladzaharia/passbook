// Guarded production deploy. Dry run unless --apply.
//   node tools/deploy.ts --check   check wrangler.jsonc only; add --secrets to also check required secret names
//   npm run deploy:check -- <flags>  same
//   npm run deploy                   print the plan
//   npm run deploy -- --apply        run every check, upload a Worker version, bookmark D1, migrate,
//                                    promote the version
//   npm run deploy -- --first --apply  first deploy, or one that adds queue consumers, workflows or
//                                    Durable Object classes: bookmark D1, migrate, then wrangler deploy
//   npm run deploy -- --migrate-only --apply   upload, bookmark, migrate; stop (cutover: bootstrap next)
//   npm run deploy -- --promote --apply         serve the version uploaded by --migrate-only, then wait for the
//                                    baked sync (WALLET_API_KEY starts it at once; else the minute cron)
//                                    (with --first: `wrangler deploy` after --migrate-only --first)
// Refuses while wrangler.jsonc still has placeholder ids or keys, or a required secret is unset.
// Migrations are forward-only. Once they run, roll forward; the previous Worker version is an
// emergency degraded mode only (docs/operations.md, Rollback). Never restore D1 to undo a deploy.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activeMissingHeads, runbookSql, waitForBakedHeads } from './lib/baked-sync-wait.ts';
import { deployFlags, deployStage, missingSecrets, parseVersionId } from './lib/deploy-plan.ts';
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
const stage = deployStage(args);
const versionFile = resolve(root, '.wrangler/deploy-version.txt');
const steps = {
  secrets: `wrangler secret list   (fails unless all of ${required.join(', ') || 'none'} are set)`,
  upload: 'wrangler versions upload   (a new version, not yet serving)',
  bookmark: `wrangler d1 time-travel info ${database}   (bookmark recorded in .wrangler/d1-bookmarks.log)`,
  migrate: `wrangler d1 migrations apply ${database} --remote`,
  bakedSync:
    'wait until every live pass has a release head (verify-heads; GET /api/v1/templates with WALLET_API_KEY triggers the sync)',
  readVersion: 'read the version id saved by --migrate-only (.wrangler/deploy-version.txt)',
  promote: first
    ? 'wrangler deploy   (registers queue consumers, workflows and Durable Object classes; serves at once)'
    : 'wrangler versions deploy <version>@100%   (promote)',
};
const plan = [
  steps.secrets,
  ...(stage === 'promote' ? (first ? [] : [steps.readVersion]) : first ? [] : [steps.upload]),
  ...(stage === 'promote' ? [] : [steps.bookmark, steps.migrate]),
  ...(stage === 'migrate' ? [] : [steps.promote, steps.bakedSync]),
];
if (!args.has('--apply')) {
  console.log(`${plan.join('\n')}\nDry run. Re-run with --apply.`);
  process.exit(0);
}

checkSecrets();

mkdirSync(resolve(root, '.wrangler'), { recursive: true });
const promote = (versionId: string | null) =>
  console.log(
    versionId ? wrangler('versions', 'deploy', `${versionId}@100%`, '--yes') : wrangler('deploy'),
  );

/**
 * Serving is not enough: baked templates only get their releases from the baked sync. The minute cron
 * runs it; `GET /api/v1/templates` with an API key (templates:read, WALLET_API_KEY) starts it at once.
 * Waits until every live pass has a release head, else exits 1.
 */
async function waitForBakedSync(): Promise<void> {
  const sql = runbookSql(readFileSync(resolve(root, 'docs/operations.md'), 'utf8'), 'verify-heads');
  if (!sql) throw new Error('docs/operations.md has no verify-heads query.');
  const base = (config as { vars?: { PUBLIC_BASE_URL?: string } }).vars?.PUBLIC_BASE_URL;
  const key = process.env.WALLET_API_KEY;
  if (!key) console.log('No WALLET_API_KEY: waiting for the minute cron to run the baked sync.');
  const missing = await waitForBakedHeads({
    trigger: async () => {
      if (!key || !base) return;
      const res = await fetch(`${base}/api/v1/templates`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) console.error(`Baked sync trigger: HTTP ${res.status}.`);
    },
    missing: async () =>
      activeMissingHeads(
        wrangler('d1', 'execute', database, '--remote', '--json', '--command', sql),
      ),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    intervalMs: 10_000,
    attempts: 18,
  });
  if (missing.length > 0) {
    console.error(
      `Promoted, but after 3 minutes these live passes have no release head:\n${missing
        .map((m) => `- ${m.id} (${m.origin}, org ${m.org_id}): ${m.passes} passes`)
        .join(
          '\n',
        )}\nThese templates cannot issue new passes until this clears; existing passes keep scanning. See docs/operations.md, "If a step fails". Roll forward; do not roll back.`,
    );
    process.exit(1);
  }
  console.log('Baked sync done: every live pass has a release head.');
}

if (stage === 'promote') {
  const saved = first ? null : readFileSync(versionFile, 'utf8').trim();
  if (!first && !saved) throw new Error('No saved version id. Run --migrate-only first.');
  promote(saved);
  await waitForBakedSync();
  process.exit(0);
}

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
  writeFileSync(versionFile, `${versionId}\n`);
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
if (stage === 'migrate')
  console.log('Migrated. The old Worker still serves. Run the bootstrap, then --promote --apply.');
else {
  promote(versionId);
  await waitForBakedSync();
}
