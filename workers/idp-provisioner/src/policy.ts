import { IdpError, type ProvisionerEnv } from './types.ts';

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Writes read the config at most this often; an unsafe answer is re-read sooner. */
export const HEALTH_TTL = 10 * 60_000;
export const UNSAFE_TTL = 60_000;

export function refuse(message: string): never {
  throw new IdpError('IDP_REFUSED', message);
}

export function assertId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) refuse(`Invalid ${kind}.`);
  return value as string;
}

export function assertTokenIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) refuse('Invalid token ids.');
  return [...new Set((value as unknown[]).map((v) => assertId('token id', v)))];
}

export function assertReason(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value)) refuse('Invalid reason.');
  return value as string;
}

const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reasons the deployment's own settings make writes unsafe. Checked before the cache and before any call. */
export function envReasons(env: ProvisionerEnv): string[] {
  const out: string[] = [];
  if (!ID.test(env.DEVELOPER_GROUP_ID ?? '')) out.push('env_group_id');
  if (!env.DEVELOPER_GROUP_NAME) out.push('env_group_name');
  else if (csv(env.PROTECTED_GROUP_NAMES ?? '').includes(env.DEVELOPER_GROUP_NAME))
    out.push('group_protected');
  if (env.POCKET_ID_API !== 'v2' && env.POCKET_ID_API !== 'admin') out.push('env_layout');
  if (!env.POCKET_ID_API_KEY) out.push('env_key');
  try {
    const url = new URL(env.POCKET_ID_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== env.POCKET_ID_ORIGIN || url.username)
      out.push('env_origin');
  } catch {
    out.push('env_origin');
  }
  return out;
}

const emptyList = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  if (raw.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
};

/** Pocket ID settings that would turn a developers-group signup into escalation (design 3.3). A missing key counts as unsafe. */
export function configReasons(
  cfg: Record<string, string>,
  groupName: string | null,
  env: ProvisionerEnv,
): string[] {
  const out: string[] = [];
  if (groupName === null) out.push('group_not_found');
  else if (groupName !== env.DEVELOPER_GROUP_NAME) out.push('group_name_mismatch');
  if (groupName !== null && csv(env.PROTECTED_GROUP_NAMES).includes(groupName))
    out.push('group_protected');
  if (cfg.allowUserSignups !== 'withToken') out.push('signups_not_token');
  if (cfg.emailVerification !== 'required') out.push('email_verification_not_required');
  if (cfg.requireUserEmail !== 'true') out.push('require_email_off');
  if (cfg.emailsVerified !== 'false') out.push('emails_verified_on');
  if (!emptyList(cfg.signupDefaultUserGroupIDs)) out.push('default_groups_set');
  return [...new Set(out)];
}

/** The only signup body the provisioner sends. Nothing the caller passes reaches it. */
export const signupBody = (env: ProvisionerEnv) => ({
  ttl: '1h',
  usageLimit: 1,
  userGroupIds: [env.DEVELOPER_GROUP_ID],
});

export const sameSet = (a: string[], b: string[]): boolean =>
  new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
