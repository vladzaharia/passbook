/**
 * The places a signed-in person moves between, and who may use each. Presentation only: the
 * server decides what a session may do. The menu, the console guard and the developer site all
 * ask `canUseSpace`, so the rule for operator spaces lives here and nowhere else.
 */
export type Space = 'passes' | 'account' | 'admin' | 'developers';
/** How the session signed in: Pocket ID, an email link or the break-glass token. */
export type SignInMethod = 'oidc' | 'magic_link' | 'breakglass';

export interface SpaceAccess {
  amr: SignInMethod;
  /** The session's roles. `developer` comes from the Pocket ID group `passbook-developers`. */
  roles: readonly string[];
  /** The person has an active membership in at least one organization. */
  orgMember: boolean;
}

/** The order the account menu lists them in. */
export const SPACES: readonly Space[] = ['passes', 'account', 'admin', 'developers'];

/** Where each space starts. `/admin/account` is Account opened inside the console. */
export const SPACE_HOME: Record<Space, string> = {
  passes: '/',
  account: '/account',
  admin: '/admin',
  developers: '/developers',
};

/** Spaces for operators: an email link opens only the holder's spaces. */
export function needsPocketId(space: Space, amr: SignInMethod): boolean {
  return (space === 'admin' || space === 'developers') && amr === 'magic_link';
}

export function canUseSpace(space: Space, access: SpaceAccess): boolean {
  if (space === 'passes' || space === 'account') return true;
  if (needsPocketId(space, access.amr)) return false;
  const admin = access.roles.includes('admin');
  // Platform admins are developers too. `developer` is read by name until the role exists.
  if (space === 'developers')
    return access.amr === 'oidc' && (admin || access.roles.includes('developer'));
  return admin || access.orgMember;
}
