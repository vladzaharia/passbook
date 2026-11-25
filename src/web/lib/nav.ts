import { Hourglass, Inbox, LayoutDashboard, type LucideIcon, Settings } from 'lucide-react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { ENTITY, type EntityKind } from './entities.ts';
import { canAccessAdminPath, isAdminPath } from './guards.ts';
import { type AdminScope, parseAdminPath, scopePath, sectionOf } from './scope.ts';

export interface NavSection {
  label: string;
  /** The path inside the scope: '' for the overview, '/passes'. */
  section: string;
  icon: LucideIcon;
  /** The entity the page lists; its icon and art come from ENTITY. */
  entity?: EntityKind;
  /** Extra search terms for the command palette. */
  keywords?: string[];
}

export interface NavItem extends NavSection {
  /** The full path in the current scope. */
  to: string;
}

const page = (
  label: string,
  section: string,
  entity: EntityKind,
  keywords?: string[],
): NavSection => ({ label, section, icon: ENTITY[entity].icon, entity, keywords });

const overview: NavSection = { label: 'Overview', section: '', icon: LayoutDashboard };
const settings: NavSection = { label: 'Settings', section: '/settings', icon: Settings };
const audit = page('Audit log', '/audit', 'audit');
const retention: NavSection = {
  label: 'Retention',
  section: '/retention',
  icon: Hourglass,
  keywords: ['holds', 'legal hold', 'receipts', 'deletion', 'privacy'],
};
const apiKeys = page('API keys', '/api-keys', 'apiKey');

/** An organization's console, in sidebar order; groups are separated by hairlines. */
export const ORG_NAV: readonly (readonly NavSection[])[] = [
  [overview],
  [
    page('Passes', '/passes', 'pass'),
    page('Templates', '/templates', 'template'),
    page('Blueprints', '/blueprints', 'blueprint', ['starter', 'blueprint']),
    page('Connections', '/connections', 'connection'),
  ],
  [
    page('Messages', '/messages', 'broadcast'),
    page('Scanning', '/scanning', 'scanner', ['scanners', 'staff', 'events', 'check in', 'nfc']),
    page('Visitors', '/visitors', 'visitor', ['guests', 'host', 'check in', 'check out']),
    {
      label: 'Test inbox',
      section: '/test-inbox',
      icon: Inbox,
      keywords: ['sandbox', 'emails'],
    },
  ],
  [
    page('Brand and channels', '/brand', 'identity', ['logo', 'apple', 'wallet']),
    page('Members', '/members', 'user', ['people', 'invitations', 'access']),
    apiKeys,
    audit,
    retention,
    { ...settings, keywords: ['organization', 'branding'] },
  ],
];

/** The platform console. */
export const PLATFORM_NAV: readonly (readonly NavSection[])[] = [
  [overview],
  [page('Organizations', '/orgs', 'org', ['tenants']), page('Users', '/users', 'user')],
  [page('Status', '/status', 'status', ['health']), audit, retention],
  [
    page('Wallet accounts', '/wallet-accounts', 'identity', [
      'apple',
      'identities',
      'certificates',
    ]),
    apiKeys,
    settings,
  ],
];

/** The scope's sections the principal may open, with full paths. A developer sandbox has no Live, so no Connections. */
export function adminNavGroups(
  scope: AdminScope | undefined,
  platformAdmin: boolean,
  membership?: OrgMembership,
): NavItem[][] {
  if (!scope) return [];
  const groups = scope.kind === 'platform' ? PLATFORM_NAV : ORG_NAV;
  return groups
    .map((group) =>
      group
        .map((item) => ({ ...item, to: scopePath(scope, item.section) }))
        .filter((item) => canAccessAdminPath(item.to, platformAdmin, membership))
        .filter((item) => !(membership?.testOnly && item.section === '/connections')),
    )
    .filter((group) => group.length > 0);
}

/** The first page a scope opens for this principal, if any. */
export function firstAllowedPath(
  scope: AdminScope,
  platformAdmin: boolean,
  membership?: OrgMembership,
): string | undefined {
  return adminNavGroups(scope, platformAdmin, membership).flat()[0]?.to;
}

/** The console section a path belongs to ("Templates"), for words about what it needs. */
export function sectionLabel(pathname: string): string | undefined {
  const { scope, rest } = parseAdminPath(pathname);
  if (!scope) return undefined;
  const section = sectionOf(rest);
  return (scope.kind === 'platform' ? PLATFORM_NAV : ORG_NAV)
    .flat()
    .find((item) => item.section === section)?.label;
}

export function isActivePath(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/passes/');
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  // The console root and a scope's overview match only themselves.
  if (to === '/admin') return path === to;
  const { scope, rest } = parseAdminPath(to);
  if (scope && rest === '') return path === to;
  return path === to || path.startsWith(`${to}/`);
}

/** Account opens inside the shell it was opened from: the console keeps its sidebar. */
export function accountPath(pathname: string): '/account' | '/admin/account' {
  return isAdminPath(pathname) ? '/admin/account' : '/account';
}
