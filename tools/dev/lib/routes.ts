// Route lists for tools/dev/visual-sweep.ts: loading, placeholder resolution, output file names.
import { readFileSync } from 'node:fs';

export type Role = 'platform' | 'org' | 'holder' | 'anon';
export type Route = { role: Role; path: string; name: string; waitFor?: string };

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export type Theme = 'light' | 'dark';

const ROLES: readonly string[] = ['platform', 'org', 'holder', 'anon'];

export function parseRoutes(json: string, source = 'route list'): Route[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error(`${source}: expected an array.`);
  return raw.map((item, i) => {
    const r = item as Partial<Route>;
    if (!r.role || !ROLES.includes(r.role) || !r.path?.startsWith('/') || !r.name) {
      throw new Error(
        `${source}[${i}]: needs role (${ROLES.join('|')}), path starting with /, name.`,
      );
    }
    return r as Route;
  });
}

export const loadRoutes = (file: string): Route[] => parseRoutes(readFileSync(file, 'utf8'), file);

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

export const placeholdersOf = (path: string): string[] =>
  [...path.matchAll(PLACEHOLDER)].map((m) => m[1] as string);

/** Fills `{key}` from `values`; undefined when any key is missing (the route is skipped). */
export function fillPath(
  path: string,
  values: Record<string, string | undefined>,
): string | undefined {
  let missing = false;
  const out = path.replace(PLACEHOLDER, (_, key: string) => {
    const value = values[key];
    if (!value) missing = true;
    return value ? encodeURIComponent(value) : '';
  });
  return missing ? undefined : out;
}

/** Safe file stem: `<name>-<viewport>-<theme>`. */
export function shotName(name: string, viewport: string, theme: string): string {
  const safe =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'page';
  return `${safe}-${viewport}-${theme}.png`;
}

/** `--only` keeps routes whose name contains any comma-separated substring. */
export function filterRoutes(routes: Route[], only?: string): Route[] {
  if (!only) return routes;
  const parts = only.split(',').map((s) => s.trim().toLowerCase());
  return routes.filter((r) => parts.some((p) => r.name.toLowerCase().includes(p)));
}
