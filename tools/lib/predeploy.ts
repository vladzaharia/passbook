interface WranglerConfig {
  vars?: Record<string, unknown>;
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
  problems.push(...cimdProblems(config.vars ?? {}));
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

/** D1 bookmarks look like 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683. */
export function parseBookmark(output: string): string | null {
  return output.match(/\b[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}\b/i)?.[0] ?? null;
}
