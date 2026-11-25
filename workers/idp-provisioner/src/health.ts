import { failure, ok, type Req } from './pocket-http.ts';
import { configReasons } from './policy.ts';
import type { Routes } from './routes.ts';
import { IdpError, type ProvisionerEnv } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body;
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};

/** Pocket ID answers settings as `[{ key, value }]`; a plain object is accepted too. */
function settings(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(body)) {
    for (const item of body as { key?: unknown; value?: unknown }[]) {
      const key = str(item?.key);
      const value = str(item?.value);
      if (key !== null && value !== null) out[key] = value;
    }
  } else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** One read of the group, the settings and the key owner's keys. Three requests, no writes. */
export async function probe(env: ProvisionerEnv, r: Routes, req: Req) {
  const group = await req('GET', r.group(env.DEVELOPER_GROUP_ID));
  const layoutSuspect = group.status === 404;
  if (!ok(group) && !layoutSuspect) throw failure(group);
  // Pocket ID answers 404 for every route of the other layout, so nothing past this read can be trusted.
  if (layoutSuspect)
    return { unsafe: ['group_not_found'], groupName: null, layoutSuspect, keyExpiresAt: null };
  const groupName = str((group.body as { name?: unknown } | null)?.name);
  if (groupName === null)
    throw new IdpError('IDP_UPSTREAM', 'Pocket ID returned an unexpected group.');

  const config = await req('GET', r.config);
  if (!ok(config)) throw failure(config);

  const keys = await req('GET', r.apiKeys);
  if (!ok(keys)) throw failure(keys);
  const expiries = list(keys.body)
    .map((k) => Date.parse(str((k as { expiresAt?: unknown } | null)?.expiresAt) ?? ''))
    .filter((t) => !Number.isNaN(t));

  return {
    unsafe: configReasons(settings(config.body), groupName, env),
    groupName,
    layoutSuspect,
    // Every key of the provisioner's own user: the nearest expiry is the one to renew.
    keyExpiresAt: expiries.length ? Math.min(...expiries) : null,
  };
}
