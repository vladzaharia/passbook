import { LayoutDashboard, type LucideIcon, Settings } from 'lucide-react';
import { ENTITY, type EntityKind } from './entities.ts';
import { isAdminPath } from './guards.ts';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The entity the page lists; its icon and art come from ENTITY. */
  entity?: EntityKind;
  /** The top-bar org scope applies to this page; elsewhere the switcher hides. */
  orgScoped: boolean;
  /** Extra search terms for the command palette. */
  keywords?: string[];
}

const page = (
  label: string,
  to: string,
  entity: EntityKind,
  orgScoped: boolean,
  keywords?: string[],
): NavItem => ({ label, to, icon: ENTITY[entity].icon, entity, orgScoped, keywords });

/** Admin IA: five groups, separated by hairlines without labels. Order is the sidebar order. */
export const ADMIN_NAV_GROUPS: readonly (readonly NavItem[])[] = [
  [{ label: 'Overview', to: '/admin', icon: LayoutDashboard, orgScoped: true }],
  [
    page('Passes', '/admin/passes', 'pass', true),
    page('Templates', '/admin/templates', 'template', true),
    page('Connections', '/admin/connections', 'connection', true),
  ],
  [
    page('Users', '/admin/users', 'user', false),
    page('Organizations', '/admin/orgs', 'org', true, ['tenants']),
  ],
  [
    page('Status', '/admin/status', 'status', false, ['health']),
    page('Audit log', '/admin/audit', 'audit', true),
  ],
  [
    page('Apple identities', '/admin/identities', 'identity', false, ['certificates']),
    page('API keys', '/admin/api-keys', 'apiKey', true),
    { label: 'Settings', to: '/admin/settings', icon: Settings, orgScoped: false },
  ],
];

export const ADMIN_NAV: readonly NavItem[] = ADMIN_NAV_GROUPS.flat();

export interface PortalNavItem {
  label: string;
  to: string;
  /** Admins only; hidden on phones, where the account menu carries it. */
  admin?: true;
}

export const PORTAL_NAV: readonly PortalNavItem[] = [
  { label: 'My passes', to: '/' },
  { label: 'Account', to: '/account' },
  { label: 'Admin', to: '/admin', admin: true },
];

export function isActivePath(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/passes/');
  if (to === '/admin') return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** False on pages the org scope does not apply to (users, settings, status, identities, account). */
export function isOrgScoped(pathname: string): boolean {
  const item = [...ADMIN_NAV]
    .sort((x, y) => y.to.length - x.to.length)
    .find((i) => isActivePath(pathname, i.to));
  return item?.orgScoped ?? false;
}

/** Account opens inside the shell it was opened from: the console keeps its sidebar. */
export function accountPath(pathname: string): '/account' | '/admin/account' {
  return isAdminPath(pathname) ? '/admin/account' : '/account';
}
