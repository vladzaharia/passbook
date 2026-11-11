import { Inbox, LayoutDashboard, type LucideIcon, Settings } from 'lucide-react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { ENTITY, type EntityKind } from './entities.ts';
import { canAccessAdminPath, isAdminPath } from './guards.ts';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** The entity the page lists; its icon and art come from ENTITY. */
  entity?: EntityKind;
  /** The selected organization is carried in this page's URL. */
  orgScoped: boolean;
  /** A tenant workspace needs both its view and its matching organization in the URL. */
  search?: { view: 'workspace'; orgId: string };
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

/** Admin IA: groups separated by hairlines, in sidebar order. */
export const ADMIN_NAV_GROUPS: readonly (readonly NavItem[])[] = [
  [{ label: 'Overview', to: '/admin', icon: LayoutDashboard, orgScoped: false }],
  [
    page('Passes', '/admin/passes', 'pass', true),
    page('Templates', '/admin/templates', 'template', true),
    page('Connections', '/admin/connections', 'connection', true),
  ],
  [
    page('Messages', '/admin/messages', 'broadcast', true),
    page('Scanning', '/admin/scanning', 'scanner', true, [
      'scanners',
      'staff',
      'events',
      'check in',
      'nfc',
    ]),
    {
      label: 'Test inbox',
      to: '/admin/test-inbox',
      icon: Inbox,
      orgScoped: true,
      keywords: ['sandbox', 'emails'],
    },
  ],
  [
    page('Users', '/admin/users', 'user', false),
    page('Organizations', '/admin/orgs', 'org', false, ['tenants']),
  ],
  [
    page('Status', '/admin/status', 'status', false, ['health']),
    page('Audit log', '/admin/audit', 'audit', false),
  ],
  [
    page('Apple identities', '/admin/identities', 'identity', false, ['certificates']),
    page('API keys', '/admin/api-keys', 'apiKey', false),
    { label: 'Settings', to: '/admin/settings', icon: Settings, orgScoped: false },
  ],
];

export const ADMIN_NAV: readonly NavItem[] = ADMIN_NAV_GROUPS.flat();

/** The directory is platform-only; members manage only their selected organization. */
export function adminNavGroups(platformAdmin: boolean, membership?: OrgMembership): NavItem[][] {
  return ADMIN_NAV_GROUPS.map((group) => {
    const items = group.filter((item) => canAccessAdminPath(item.to, platformAdmin, membership));
    if (!platformAdmin && membership && group.some((item) => item.to === '/admin/orgs')) {
      const to = `/admin/orgs/${encodeURIComponent(membership.orgId)}`;
      if (canAccessAdminPath(to, false, membership, 'workspace')) {
        items.push({
          ...page('Organization', to, 'org', false, ['members', 'team']),
          search: { view: 'workspace', orgId: membership.orgId },
        });
      }
    }
    return items;
  }).filter((group) => group.length > 0);
}

/** A member can enter the console without selecting an organization implicitly. */
export function adminEntryPath(
  platformAdmin: boolean,
  membership?: OrgMembership,
  memberships: readonly OrgMembership[] = [],
): string {
  if (platformAdmin) return '/admin';
  const candidates = membership ? [membership] : memberships;
  return (
    [
      '/admin/passes',
      '/admin/templates',
      '/admin/connections',
      '/admin/scanning',
      '/admin/messages',
      '/admin/test-inbox',
    ].find((path) => candidates.some((candidate) => canAccessAdminPath(path, false, candidate))) ??
    '/admin/account'
  );
}

/** The console section a path belongs to ("Templates"), for words about what it needs. */
export function sectionLabel(pathname: string): string | undefined {
  return ADMIN_NAV.filter((item) => item.to !== '/admin' && isActivePath(pathname, item.to)).sort(
    (a, b) => b.to.length - a.to.length,
  )[0]?.label;
}

/** The organization an Admin link carries: the selection, or the only one the member has. */
export function entryOrgId(
  membership: OrgMembership | undefined,
  memberships: readonly OrgMembership[],
): string | undefined {
  return (membership ?? (memberships.length === 1 ? memberships[0] : undefined))?.orgId;
}

export interface PortalNavItem {
  label: string;
  to: string;
  /** Console access only; hidden on phones, where the account menu carries it. */
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

/** Whether a page carries a tenant workspace selection in its URL. */
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
