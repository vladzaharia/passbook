interface WranglerConfig {
  vars?: Record<string, unknown>;
  routes?: { pattern: string; custom_domain?: boolean }[];
  send_email?: { name: string; allowed_sender_addresses?: string[] }[];
  d1_databases?: { binding: string; database_id?: string }[];
  mtls_certificates?: { binding: string; certificate_id?: string }[];
}

const ZERO_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const TURNSTILE_TEST_KEY = /^[123]x0{20}/;
const PLACEHOLDER = /placeholder|<[^>]+>|changeme/i;
/** Same path as CIMD_PATH in src/worker/modules/auth/oidc-cimd.ts. */
const CIMD_PATH = '/auth/oidc/client-metadata.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PredeployOptions {
  /** Deploy without APNs push (no mtls_certificates binding named APNS). */
  allowNoPush?: boolean;
  /** Deploy before Pocket ID has a client: OIDC_CLIENT_ID may stay a placeholder (break-glass only). */
  allowNoOidc?: boolean;
}

/** Problems that make a production deploy wrong. Empty means the config is ready. */
export function predeployProblems(
  config: WranglerConfig,
  options: PredeployOptions = {},
): string[] {
  const problems: string[] = [];
  for (const db of config.d1_databases ?? []) {
    if (!db.database_id || ZERO_UUID.test(db.database_id))
      problems.push(
        `d1_databases ${db.binding}: database_id is a placeholder. Run wrangler d1 create.`,
      );
  }
  for (const [key, value] of Object.entries(config.vars ?? {})) {
    if (typeof value !== 'string') continue;
    const oidcSkipped = key === 'OIDC_CLIENT_ID' && options.allowNoOidc;
    if (PLACEHOLDER.test(value) && !oidcSkipped)
      problems.push(`vars.${key} is a placeholder (${value}).`);
    if (key === 'TURNSTILE_SITE_KEY' && TURNSTILE_TEST_KEY.test(value))
      problems.push('vars.TURNSTILE_SITE_KEY is a Cloudflare test key.');
  }
  problems.push(...cimdProblems(config.vars ?? {}), ...domainProblems(config));
  const apns = (config.mtls_certificates ?? []).find((m) => m.binding === 'APNS');
  if (!apns) {
    if (!options.allowNoPush)
      problems.push('mtls_certificates has no APNS binding. Run npm run identity:add.');
  } else if (
    !apns.certificate_id ||
    !UUID.test(apns.certificate_id) ||
    ZERO_UUID.test(apns.certificate_id)
  ) {
    problems.push('mtls_certificates APNS: certificate_id is not a certificate id.');
  }
  return problems;
}

/** A URL client id is a Client ID Metadata Document this Worker serves (oidc-cimd.ts). */
function cimdProblems(vars: Record<string, unknown>): string[] {
  const id = vars.OIDC_CLIENT_ID;
  const base =
    typeof vars.PUBLIC_BASE_URL === 'string' ? vars.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
  if (typeof id !== 'string' || !/^https?:\/\//.test(id)) return [];
  return id === `${base}${CIMD_PATH}`
    ? []
    : [`vars.OIDC_CLIENT_ID must be ${base}${CIMD_PATH} to use a client metadata document.`];
}

/**
 * Every custom domain is either PUBLIC_BASE_URL's host or a REDIRECT_HOSTS host; the Worker refuses
 * any other (src/worker/platform/host-policy.ts). The sender must be one the binding allows.
 */
function domainProblems(config: WranglerConfig): string[] {
  const vars = config.vars ?? {};
  const problems: string[] = [];
  let canonical: string | null = null;
  try {
    const url = new URL(String(vars.PUBLIC_BASE_URL));
    if (url.protocol !== 'https:') problems.push('vars.PUBLIC_BASE_URL must be https.');
    canonical = url.host;
  } catch {
    problems.push('vars.PUBLIC_BASE_URL is not a URL.');
  }
  const redirects = String(vars.REDIRECT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const routes = config.routes ?? [];
  const hosts = routes.map((r) => r.pattern.toLowerCase());
  for (const r of routes)
    if (!r.custom_domain) problems.push(`routes ${r.pattern}: only custom domains are supported.`);
  if (canonical && !hosts.includes(canonical))
    problems.push(`routes has no custom domain for ${canonical} (vars.PUBLIC_BASE_URL).`);
  for (const host of redirects)
    if (!hosts.includes(host)) problems.push(`vars.REDIRECT_HOSTS: ${host} has no route.`);
  for (const host of hosts)
    if (host !== canonical && !redirects.includes(host))
      problems.push(
        `routes ${host} is not PUBLIC_BASE_URL or in REDIRECT_HOSTS: it would be refused.`,
      );
  const from = vars.EMAIL_FROM;
  const allowed = config.send_email?.find((b) => b.name === 'EMAIL')?.allowed_sender_addresses;
  if (typeof from === 'string' && allowed && !allowed.includes(from))
    problems.push(`vars.EMAIL_FROM ${from} is not in send_email allowed_sender_addresses.`);
  return problems;
}

/** D1 bookmarks look like 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683. */
export function parseBookmark(output: string): string | null {
  return output.match(/\b[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}\b/i)?.[0] ?? null;
}
