/**
 * The places a signed-in person moves between, and who may use each. Presentation only: the
 * server decides what a session may do. The menu, the console guard and the developer site all
 * ask `canUseSpace`, so the rule for operator spaces lives here and nowhere else.
 */
export type Space = 'passes' | 'account' | 'admin' | 'workbench' | 'developers';
/** How the session signed in: Pocket ID, an email link or the break-glass token. */
export type SignInMethod = 'oidc' | 'magic_link' | 'breakglass';

export interface SpaceAccess {
  amr: SignInMethod;
  /** The session's roles. `developer` comes from the Pocket ID group `passbook_developers`. */
  roles: readonly string[];
  /** The person has an active membership in at least one organization. */
  orgMember: boolean;
  /** An email session's console grace end (ms), when it has one. */
  consoleUntil?: number | null;
  /** The platform requires the admin group (`console` role) for Admin: Polaris ID sessions only. */
  consoleGroupRequired?: boolean;
}

/** The order the account menu lists them in. */
export const SPACES: readonly Space[] = ['passes', 'account', 'admin', 'workbench', 'developers'];

/** Where each space starts. `/admin/account` is Account opened inside the console. */
export const SPACE_HOME: Record<Space, string> = {
  passes: '/',
  account: '/account',
  admin: '/admin',
  workbench: '/workbench',
  developers: '/developers',
};

/** Spaces for operators: an email link opens only the holder's spaces. */
export function needsPocketId(
  space: Space,
  amr: SignInMethod,
  consoleUntil?: number | null,
  now: number = Date.now(),
): boolean {
  if (amr !== 'magic_link') return false;
  // An email session still inside the console grace window keeps Admin (not Developers).
  if (space === 'admin' && consoleUntil != null && now < consoleUntil) return false;
  return space === 'admin' || space === 'workbench' || space === 'developers';
}

export type OperatorSpace = 'admin' | 'workbench' | 'developers';

/** The operator space a path opens, else null. Drives the sign-in page's layout. */
export function operatorSpaceOf(path: string | null | undefined): OperatorSpace | null {
  const first = (path ?? '').split(/[/?#]/)[1];
  return first === 'admin' || first === 'workbench' || first === 'developers' ? first : null;
}

/** Developer features: the `developer` role, which platform admins have implied. */
export const hasDeveloperAccess = (roles: readonly string[]): boolean =>
  roles.includes('admin') || roles.includes('developer');

/** Console access by group: the admin group (`console`), or a platform admin. */
export const hasConsoleGroup = (roles: readonly string[]): boolean =>
  roles.includes('admin') || roles.includes('console');

export function canUseSpace(space: Space, access: SpaceAccess): boolean {
  if (space === 'passes' || space === 'account') return true;
  if (needsPocketId(space, access.amr, access.consoleUntil)) return false;
  const admin = access.roles.includes('admin');
  if (space === 'developers') return access.amr === 'oidc' && hasDeveloperAccess(access.roles);
  const consoleGroup =
    !access.consoleGroupRequired || access.amr !== 'oidc' || hasConsoleGroup(access.roles);
  // The Workbench: Polaris ID, and a sandbox (the developer role) or an org's Test as its admin.
  if (space === 'workbench')
    return (
      access.amr === 'oidc' &&
      (hasDeveloperAccess(access.roles) || (access.orgMember && consoleGroup))
    );
  if (!consoleGroup) return false;
  return admin || access.orgMember;
}
