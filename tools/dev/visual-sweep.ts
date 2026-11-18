// Visual sweep: signs in per role, screenshots a route list at three viewports and two themes.
// node tools/dev/visual-sweep.ts --url http://localhost:5273 --routes tools/dev/visual-routes/admin.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRequestContext } from 'playwright';
import { assertLocal } from '../lib/demo-client.ts';
import { contextFor } from './lib/auth.ts';
import { capture } from './lib/capture.ts';
import { captureEmails } from './lib/emails.ts';
import { resolvePlaceholders } from './lib/resolve.ts';
import {
  filterRoutes,
  loadRoutes,
  placeholdersOf,
  type Role,
  type Theme,
  VIEWPORTS,
  type ViewportName,
} from './lib/routes.ts';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const arg = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const list = <T extends string>(
  value: string | undefined,
  all: readonly T[],
  what: string,
): T[] => {
  if (!value) return [...all];
  const picked = value.split(',').map((s) => s.trim()) as T[];
  const bad = picked.find((p) => !all.includes(p));
  if (bad) throw new Error(`Unknown ${what} "${bad}"; use ${all.join(', ')}.`);
  return picked;
};

async function main() {
  const base = assertLocal(arg('--url') ?? 'http://localhost:5173');
  const files = (arg('--routes') ?? '').split(',').filter(Boolean);
  if (files.length === 0 && !flag('--emails'))
    throw new Error('Pass --routes <file[,file]> and/or --emails.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(root, arg('--out') ?? `.wrangler/visual-sweep/${stamp}`);
  const stateDir = resolve(root, '.wrangler/visual-sweep/state');
  const viewports = list<ViewportName>(
    arg('--viewports'),
    Object.keys(VIEWPORTS) as ViewportName[],
    'viewport',
  );
  const themes = list<Theme>(arg('--themes'), ['light', 'dark'], 'theme');

  const routes = filterRoutes(
    files.flatMap((f) => loadRoutes(resolve(root, f))),
    arg('--only'),
  );
  const contexts = new Map<Role, Promise<APIRequestContext>>();
  const ctx = (role: Role) => {
    if (!contexts.has(role)) contexts.set(role, contextFor(base, stateDir, role));
    return contexts.get(role) as Promise<APIRequestContext>;
  };
  // Sign in (or reuse saved state) once for every role a route needs.
  for (const role of new Set(routes.map((r) => r.role))) if (role !== 'anon') await ctx(role);
  const needed = ['orgId', ...routes.flatMap((r) => placeholdersOf(r.path))];
  const values = await resolvePlaceholders(
    { platform: () => ctx('platform'), org: () => ctx('org'), holder: () => ctx('holder') },
    needed,
  );

  mkdirSync(out, { recursive: true });
  const shots =
    routes.length > 0
      ? await capture({ base, out, stateDir, viewports, themes, values }, routes)
      : [];
  if (flag('--emails'))
    shots.push(
      ...(await captureEmails({
        base,
        out,
        viewports,
        themes,
        ...(arg('--only') ? { only: arg('--only') as string } : {}),
      })),
    );
  writeFileSync(resolve(out, 'index.json'), `${JSON.stringify(shots, null, 2)}\n`);

  const written = shots.filter((s) => s.file).length;
  const noisy = shots.filter((s) => s.consoleErrors.length || s.failedRequests.length).length;
  const skipped = shots.filter((s) => !s.file).length;
  console.log(
    `${written} screenshots, ${noisy} with console/request errors, ${skipped} skipped -> ${out}`,
  );
  for (const c of contexts.values()) await (await c).dispose();
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
