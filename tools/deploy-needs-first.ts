// node tools/deploy-needs-first.ts <previous wrangler.jsonc> <current wrangler.jsonc>
// Prints one line per resource the current config adds that needs `deploy --first`; exits 0 either way.

import { readJsonc } from './lib/jsonc.ts';
import { firstDeployReasons } from './lib/needs-first.ts';

const [previous, current] = process.argv.slice(2);
if (!previous || !current) {
  console.error('usage: deploy-needs-first.ts <previous> <current>');
  process.exit(2);
}
for (const reason of firstDeployReasons(
  readJsonc(previous) as Parameters<typeof firstDeployReasons>[0],
  readJsonc(current) as Parameters<typeof firstDeployReasons>[1],
))
  console.log(reason);
