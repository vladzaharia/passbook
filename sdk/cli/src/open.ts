import type { LoginIo } from './login.ts';

/** The tools a person names to `passbook open`: the Workbench areas of the profile's context. */
const TOOLS = new Set([
  'home',
  'design',
  'passes',
  'console',
  'logs',
  'events',
  'inbox',
  'activity',
  'keys',
]);

/** A target is opened only on the profile's own origin, under these folders. */
const PREFIXES = ['/workbench', '/developers', '/admin'];

/** The URL to open, or null: it must be on `origin` and under `/workbench/`, `/developers/` or `/admin/`. */
export function openTarget(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  const inside = PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
  return inside ? url.href : null;
}

/**
 * `passbook open [id|tool]`: a plain URL on the profile's origin, in the browser's own Polaris ID session. No token,
 * code or body is added, and there is no sign-in link.
 */
export async function openCommand(io: LoginIo, target: string | undefined): Promise<void> {
  const profile = await io.store.get(io.origin);
  if (!profile) throw new Error('Not signed in. Run passbook login.');
  const base = `${io.origin}/workbench/o/${encodeURIComponent(profile.orgId)}`;
  let href = base;
  if (target && TOOLS.has(target)) href = target === 'home' ? base : `${base}/${target}`;
  else if (target) {
    // A pasted id: the server says what it is and where it opens.
    const res = await io.fetch(`${io.origin}/api/v1/resolve?id=${encodeURIComponent(target)}`, {
      headers: { authorization: `Bearer ${profile.token}`, accept: 'application/json' },
      redirect: 'error',
    });
    if (res.status === 404)
      throw new Error(`${target} is not in ${profile.context.name}'s Test data.`);
    if (!res.ok) throw new Error(`Could not look up ${target} (${res.status}).`);
    href = ((await res.json()) as { href?: string }).href ?? '';
  }
  const url = openTarget(href, io.origin);
  if (!url) throw new Error('The server named a page outside the Workbench. Not opened.');
  io.out(url);
  await io.openBrowser?.(url);
}
