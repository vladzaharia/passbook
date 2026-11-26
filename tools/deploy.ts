// Guarded production deploy. Dry run unless --apply.
//   node tools/deploy.ts --check   check wrangler.jsonc only; add --secrets to also check required secret names
//   npm run deploy:check -- <flags>  same; --require-wallet-migrated also queries the remote D1 (also checked before
//                                    migrating and serving; on by itself for a flip and once any wallet is released)
//   npm run deploy                   print the plan
//   npm run deploy -- --apply        run every check, upload a Worker version, bookmark D1, migrate,
//                                    promote the version
//   npm run deploy -- --first --apply  first deploy, or one that adds queue consumers, workflows or
//                                    Durable Object classes: bookmark D1, migrate, then wrangler deploy
//   npm run deploy -- --migrate-only --apply   upload, bookmark, migrate; stop (cutover: bootstrap next)
//   npm run deploy -- --promote --apply         serve the version uploaded by --migrate-only, then wait for the
//                                    baked sync (WALLET_API_KEY starts it at once; else the minute cron)
//                                    (with --first: `wrangler deploy` after --migrate-only --first)
// Refuses unless the working tree is clean and dist/ was built from HEAD (tools/stamp-build.ts writes the stamp; --promote checks the commit --migrate-only uploaded). Refuses while wrangler.jsonc still has placeholder ids or keys,
// or a required secret is unset on the Worker or on a bound connector Worker (workers/*); a flag before `--`; a full deploy while 0029_org_memberships is pending (the cutover); a promote while
// any migration is pending. Migrations are forward-only. Once they run, roll forward; the previous Worker version is an
// emergency degraded mode only (docs/operations.md, Rollback). Never restore D1 to undo a deploy.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { keyRingProblems } from '../src/worker/platform/mac-key-config.ts';
import {
  activeMissingHeads,
  runbookSql,
  singleSelect,
  waitForBakedHeads,
} from './lib/baked-sync-wait.ts';
import { buildProblem, gitState, stampPath } from './lib/build-stamp.ts';
import { readPending } from './lib/changelog-files.ts';
import {
  deployFlags,
  deployStage,
  missingSecrets,
  parseVersionId,
  pendingMigrations,
  pendingRefusal,
  secretNames,
  uploadAndMigrate,
} from './lib/deploy-plan.ts';
import { e2eReleaseProblems } from './lib/e2e-release.ts';
import { entitlementsRefusal, orgsWithoutEntitlements } from './lib/entitlements-gate.ts';
import { readJsonc } from './lib/jsonc.ts';
import { parseBookmark, predeployProblems } from './lib/predeploy.ts';
import { requireServiceSecrets } from './lib/service-secrets.ts';
import { unmigratedWalletAccounts, walletMigrationRefusal } from './lib/wallet-migrate-gate.ts';
import { anyWalletReleased, walletReleaseRefusal } from './lib/wallet-release-deploy.ts';

const root = resolve(import.meta.dirname, '..');
const args = (() => {
  try {
    return deployFlags(process.argv.slice(2), process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
const database = 'passbook-platform';

const config = readJsonc(resolve(root, 'wrangler.jsonc')) as Parameters<
  typeof predeployProblems
>[0] & {
  secrets?: { required?: string[] };
  services?: { service: string }[];
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
const remote = (sql: string) =>
  wrangler('d1', 'execute', database, '--remote', '--json', '--command', sql);

const required = config.secrets?.required ?? [];
const checkSecrets = () => {
  const listed = wrangler('secret', 'list', '--format', 'json');
  const missing = missingSecrets(required, listed);
  if (missing.length > 0) {
    console.error(`Not migrating. Set with wrangler secret put: ${missing.join(', ')}`);
    process.exit(1);
  }
  requireServiceSecrets(config.services, resolve(root, 'workers'), (service) =>
    wrangler('secret', 'list', '--name', service, '--format', 'json'),
  );
  const versions = (prefix: string) =>
    secretNames(listed).flatMap((name) => {
      const match = new RegExp(`^${prefix}_V([1-9]\\d*)$`).exec(name);
      return match ? [Number(match[1])] : [];
    });
  const macProblems = keyRingProblems({
    kek: versions('KEK'),
    macRoot: versions('MAC_ROOT'),
    pin: config.vars?.MAC_KEY_VERSION,
    previous: config.vars?.MAC_KEY_VERSION_PREVIOUS,
  });
  if (macProblems.length > 0) {
    console.error(`Not migrating:\n${macProblems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
};
if (args.has('--check')) {
  if (args.has('--secrets')) checkSecrets();
  requireWalletMigrated();
  console.log('wrangler.jsonc is ready to deploy.');
  process.exit(0);
}

// `versions upload` cannot create the Worker, apply Durable Object class changes or (as far as
// Cloudflare documents) register queue consumers and workflows; only `wrangler deploy` does.
const first = args.has('--first');
const stage = deployStage(args);
const versionFile = resolve(root, '.wrangler/deploy-version.txt');
const shaFile = resolve(root, '.wrangler/deploy-sha.txt');
const steps = {
  build: `refuses unless the working tree is clean and ${stage === 'promote' && !first ? 'the uploaded version was built from HEAD' : 'dist/ was built from HEAD (npm run build)'}`,
  secrets: `wrangler secret list   (fails unless all of ${required.join(', ') || 'none'} are set)`,
  pending:
    stage === 'promote'
      ? `wrangler d1 migrations list ${database} --remote   (refuses while any migration is pending)`
      : `wrangler d1 migrations list ${database} --remote   (refuses while 0029_org_memberships is pending: the cutover is --migrate-only, bootstrap, --promote)`,
  upload: 'wrangler versions upload   (a new version, not yet serving)',
  bookmark: `wrangler d1 time-travel info ${database}   (bookmark recorded in .wrangler/d1-bookmarks.log)`,
  migrate: `wrangler d1 migrations apply ${database} --remote`,
  bakedSync:
    'wait until every live pass has a release head (verify-heads; GET /api/v1/templates with WALLET_API_KEY triggers the sync)',
  saveVersion: 'save the version id for --promote (.wrangler/deploy-version.txt)',
  readVersion: 'read the version id saved by --migrate-only (.wrangler/deploy-version.txt)',
  entitlements: `wrangler d1 execute ${database} --remote   (refuses while any org has no org_entitlements row: the entitlements-gate query)`,
  promote: first
    ? 'wrangler deploy   (registers queue consumers, workflows and Durable Object classes; serves at once)'
    : 'wrangler versions deploy <version>@100%   (promote)',
};
const plan = [
  steps.build,
  steps.secrets,
  ...(stage === 'migrate' ? [] : [steps.pending]),
  ...(stage === 'promote' ? (first ? [] : [steps.readVersion]) : first ? [] : [steps.upload]),
  ...(stage === 'promote' ? [] : [steps.bookmark, steps.migrate]),
  ...(stage === 'migrate' && !first ? [steps.saveVersion] : []),
  ...(stage === 'migrate' ? [] : [steps.entitlements, steps.promote, steps.bakedSync]),
];
if (!args.has('--apply')) {
  console.log(`${plan.join('\n')}\nDry run. Re-run with --apply.`);
  process.exit(0);
}

// Migrations come from this working tree and the Worker from dist/: both must be the same clean HEAD.
const git = gitState(root);
const unstamped = readPending(root).length;
if (unstamped > 0)
  console.warn(
    `Warning: docs/api/changelog/unreleased.json has ${unstamped} entries; npm run changelog:release stamps them. Deploying anyway.`,
  );
const buildRefusal = buildProblem({
  servesUploaded: stage === 'promote' && !first,
  git,
  stamp: existsSync(stampPath(root)) ? readFileSync(stampPath(root), 'utf8') : null,
  uploadedSha: existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim() : null,
  e2eRelease: e2eReleaseProblems(resolve(root, 'dist/passbook')),
});
if (buildRefusal) {
  console.error(`Not deploying. ${buildRefusal}`);
  process.exit(1);
}
checkSecrets();
const pending = pendingMigrations(wrangler('d1', 'migrations', 'list', database, '--remote'));
// Wallet release writes are printed; a flip needs every account on a source, a dark write no copies left.
const refusal =
  (stage === 'migrate' ? null : pendingRefusal(stage, pending)) ??
  walletReleaseRefusal({ root, pending, log: console.log, remote, flags: args });
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
requireWalletMigrated();

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
  const block = runbookSql(
    readFileSync(resolve(root, 'docs/operations.md'), 'utf8'),
    'verify-heads',
  );
  if (!block) throw new Error('docs/operations.md has no verify-heads query.');
  const sql = singleSelect(block);
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
        )}\nThese templates cannot issue new passes until this clears; existing passes keep scanning. See docs/operations.md, "Baked sync wait". Roll forward; do not roll back.`,
    );
    process.exit(1);
  }
  console.log('Baked sync done: every live pass has a release head.');
}

/** PE3: serve only when no wallet account lacks a credential source (`--require-wallet-migrated`). */
function requireWalletMigrated(): void {
  if (!args.has('--require-wallet-migrated')) return;
  const block = runbookSql(
    readFileSync(resolve(root, 'docs/operations.md'), 'utf8'),
    'wallet-migration-gate',
  );
  if (!block) throw new Error('docs/operations.md has no wallet-migration-gate query.');
  const refusal = walletMigrationRefusal(unmigratedWalletAccounts(remote(singleSelect(block))));
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}

/** MT2: never serve while an org has no entitlements row (it would be refused every key call). Always on. */
function requireEntitlements(): void {
  const block = runbookSql(
    readFileSync(resolve(root, 'docs/operations.md'), 'utf8'),
    'entitlements-gate',
  );
  if (!block) throw new Error('docs/operations.md has no entitlements-gate query.');
  const refusal = entitlementsRefusal(orgsWithoutEntitlements(remote(singleSelect(block))));
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}

/** Before serving: entitlements always; the wallet migration gate when asked or once any wallet is released. */
function beforeServe(): void {
  if (anyWalletReleased(remote)) args.add('--require-wallet-migrated');
  requireWalletMigrated();
  requireEntitlements();
}

if (stage === 'promote') {
  beforeServe();
  const saved = first || !existsSync(versionFile) ? null : readFileSync(versionFile, 'utf8').trim();
  if (!first && !saved) throw new Error('No saved version id. Run --migrate-only first.');
  promote(saved);
  await waitForBakedSync();
  process.exit(0);
}

const outputFile = resolve(root, '.wrangler/deploy-output.ndjson');
const versionId = uploadAndMigrate({
  clearVersion: () => {
    rmSync(versionFile, { force: true });
    rmSync(shaFile, { force: true });
  },
  upload: () => {
    if (first) return null;
    writeFileSync(outputFile, '');
    const uploaded = execFileSync('npx', ['wrangler', 'versions', 'upload'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const id = parseVersionId(readFileSync(outputFile, 'utf8'), uploaded);
    if (!id) throw new Error('No version id from wrangler versions upload. Not migrating.');
    console.log(`Uploaded Worker version ${id}; previous version keeps serving.`);
    return id;
  },
  bookmark: () => {
    const bookmark = parseBookmark(wrangler('d1', 'time-travel', 'info', database));
    if (!bookmark) throw new Error('No D1 bookmark in the wrangler output. Not migrating.');
    appendFileSync(
      resolve(root, '.wrangler/d1-bookmarks.log'),
      `${new Date().toISOString()} ${bookmark}\n`,
    );
    console.log(
      `D1 bookmark ${bookmark}. Last resort only: a restore drops everything written since, including pass tombstones.`,
    );
  },
  migrate: () => console.log(wrangler('d1', 'migrations', 'apply', database, '--remote')),
  saveVersion: (id) => {
    writeFileSync(versionFile, `${id}\n`);
    writeFileSync(shaFile, `${git.head}\n`);
  },
});
if (stage === 'migrate')
  console.log('Migrated. The old Worker still serves. Run the bootstrap, then --promote --apply.');
else {
  beforeServe();
  promote(versionId);
  await waitForBakedSync();
}
