// Guarded production deploy. Dry run unless --apply.
//   npm run predeploy            check wrangler.jsonc only
//   npm run deploy               print the plan
//   npm run deploy -- --apply    bookmark D1, apply remote migrations, deploy
// Refuses while wrangler.jsonc still has placeholder ids or keys.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonc } from './lib/jsonc.ts';
import { parseBookmark, predeployProblems } from './lib/predeploy.ts';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const database = 'wallet-platform';

const problems = predeployProblems(readJsonc(resolve(root, 'wrangler.jsonc')), {
  allowNoPush: args.has('--allow-no-push'),
  allowNoOidc: args.has('--allow-no-oidc'),
});
if (problems.length > 0) {
  console.error(`Not deploying. Fix wrangler.jsonc:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
if (args.has('--check')) {
  console.log('wrangler.jsonc is ready to deploy.');
  process.exit(0);
}

const wrangler = (...a: string[]) =>
  execFileSync('npx', ['wrangler', ...a], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const plan = [
  `wrangler d1 time-travel info ${database}   (bookmark recorded in .wrangler/d1-bookmarks.log)`,
  `wrangler d1 migrations apply ${database} --remote`,
  'wrangler deploy',
];
if (!args.has('--apply')) {
  console.log(`${plan.join('\n')}\nDry run. Re-run with --apply.`);
  process.exit(0);
}

const bookmark = parseBookmark(wrangler('d1', 'time-travel', 'info', database));
if (!bookmark) throw new Error('No D1 bookmark in the wrangler output. Not migrating.');
mkdirSync(resolve(root, '.wrangler'), { recursive: true });
appendFileSync(
  resolve(root, '.wrangler/d1-bookmarks.log'),
  `${new Date().toISOString()} ${bookmark}\n`,
);
console.log(
  `D1 bookmark ${bookmark}. Restore: wrangler d1 time-travel restore ${database} --bookmark ${bookmark}`,
);
console.log(wrangler('d1', 'migrations', 'apply', database, '--remote'));
console.log(wrangler('deploy'));
