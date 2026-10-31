import {
  Activity,
  Building2,
  Cable,
  FileStack,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings,
  Ticket,
  Users,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette. */
  keywords?: string[];
}

/** Admin IA (spec section 13). Order is the sidebar order. */
export const ADMIN_NAV: readonly NavItem[] = [
  { label: 'Overview', to: '/admin', icon: LayoutDashboard },
  { label: 'Passes', to: '/admin/passes', icon: Ticket },
  { label: 'Templates', to: '/admin/templates', icon: FileStack },
  { label: 'Connections', to: '/admin/connections', icon: Cable },
  { label: 'Users', to: '/admin/users', icon: Users },
  { label: 'Organizations', to: '/admin/orgs', icon: Building2, keywords: ['tenants'] },
  { label: 'Apple identities', to: '/admin/identities', icon: Fingerprint, keywords: ['certificates'] },
  { label: 'API keys', to: '/admin/api-keys', icon: KeyRound },
  { label: 'Status', to: '/admin/status', icon: Activity, keywords: ['health'] },
  { label: 'Settings', to: '/admin/settings', icon: Settings },
  { label: 'Audit log', to: '/admin/audit', icon: ScrollText },
];

export const PORTAL_NAV: readonly Pick<NavItem, 'label' | 'to'>[] = [
  { label: 'My passes', to: '/' },
  { label: 'Account', to: '/account' },
];

export function isActivePath(pathname: string, to: string): boolean {
  if (to === '/admin' || to === '/') return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}
