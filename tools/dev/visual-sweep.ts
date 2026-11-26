// Visual sweep: signs in per role, screenshots a route list at three viewports and two themes.
// node tools/dev/visual-sweep.ts --url http://localhost:5273 --routes tools/dev/visual-routes/admin.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { assertLocal } from '../lib/demo-client.ts';
import { contextFor } from './lib/auth.ts';
import { capture } from './lib/capture.ts';
import { writeContactSheets } from './lib/contact-sheet.ts';
import { captureEmails } from './lib/emails.ts';
import { pickJourneys } from './lib/journey.ts';
import { makeEnv } from './lib/journey-env.ts';
import { runJourney } from './lib/journey-run.ts';
import { resolvePlaceholders } from './lib/resolve.ts';
import {
  ALL_VIEWPORTS,
  DEFAULT_VIEWPORTS,
  filterRoutes,
  loadRoutes,
  placeholdersOf,
  type Role,
  type Theme,
  type ViewportName,
} from './lib/routes.ts';
import { journeys } from './visual-journeys/index.ts';

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

/** Org slug to id, as the break-glass admin sees them. */
async function orgIds(base: string, stateDir: string): Promise<Record<string, string>> {
  const platform = await contextFor(base, stateDir, 'platform');
  const res = await platform.get('/api/v1/orgs?limit=100');
  const items = ((await res.json()) as { items?: { slug: string; id: string }[] }).items ?? [];
  await platform.dispose();
  return Object.fromEntries(items.map((o) => [o.slug, o.id]));
}

async function main() {
  const base = assertLocal(arg('--url') ?? 'http://localhost:5173');
  const files = (arg('--routes') ?? '').split(',').filter(Boolean);
  const journeyNames = arg('--journeys');
  if (files.length === 0 && !flag('--emails') && !journeyNames)
    throw new Error('Pass --routes <file[,file]>, --emails and/or --journeys <name[,name]|all>.');
  if (journeyNames) {
    const only = pickJourneys(journeys, journeyNames);
    const stateDir = resolve(root, '.wrangler/visual-sweep/state');
    const orgs = await orgIds(base, stateDir);
    const out = resolve(root, arg('--out') ?? '.wrangler/visual-sweep/journeys');
    if (!out.startsWith(`${resolve(root, '.wrangler')}/`))
      throw new Error('--out must be inside .wrangler/ (screenshots show signed-in data).');
    for (const journey of only) {
      const env = makeEnv({
        base,
        stateDir,
        orgs,
        orgSlug: journey.org,
        contexts: (role) => contextFor(base, stateDir, role),
      });
      const steps = await runJourney(journey, env, {
        base,
        out,
        stateDir,
        viewports: list<ViewportName>(arg('--viewports'), DEFAULT_VIEWPORTS, 'viewport'),
        themes: list<Theme>(arg('--themes'), ['light', 'dark'], 'theme'),
      });
      const shots = steps.reduce((n, s) => n + Object.keys(s.files).length, 0);
      const noted = steps.filter((s) => s.note);
      console.log(
        `${journey.name}: ${steps.length} steps, ${shots} screenshots -> ${resolve(out, journey.name)}`,
      );
      for (const s of noted) console.log(`  ${s.index + 1}. ${s.title}: ${s.note}`);
    }
    if (files.length === 0 && !flag('--emails')) return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(root, arg('--out') ?? `.wrangler/visual-sweep/${stamp}`);
  if (!out.startsWith(`${resolve(root, '.wrangler')}/`)) {
    throw new Error('--out must be inside .wrangler/ (screenshots show signed-in data).');
  }
  const stateDir = resolve(root, '.wrangler/visual-sweep/state');
  const narrow = Boolean(arg('--viewports'));
  const viewports: ViewportName[] = narrow
    ? list(arg('--viewports'), ALL_VIEWPORTS, 'viewport')
    : [...DEFAULT_VIEWPORTS];
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
  const needed = [
    'orgId',
    ...routes.flatMap((r) => [...placeholdersOf(r.path), ...(r.filterOrg ? [r.filterOrg] : [])]),
  ];
  const values = await resolvePlaceholders(
    { platform: () => ctx('platform'), org: () => ctx('org'), holder: () => ctx('holder') },
    needed,
  );

  mkdirSync(out, { recursive: true });
  const shots =
    routes.length > 0
      ? await capture({ base, out, stateDir, viewports, narrow, themes, values }, routes)
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
  const sheets = await writeContactSheets(out, shots);

  const written = shots.filter((s) => s.file).length;
  const noisy = shots.filter((s) => s.consoleErrors.length || s.failedRequests.length).length;
  const skipped = shots.filter((s) => !s.file).length;
  console.log(
    `${written} screenshots, ${sheets} contact sheets, ${noisy} with console/request errors, ${skipped} skipped -> ${out}`,
  );
  for (const c of contexts.values()) await (await c).dispose();
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
