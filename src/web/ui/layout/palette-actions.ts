import { ArrowLeftRight, Plus, RefreshCw, Upload } from 'lucide-react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { ENTITY } from '../../lib/entities.ts';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { THEME_OPTIONS, type ThemePref } from '../../lib/theme.tsx';
import type { CommandItem } from '../command-palette.tsx';

type PaletteActionOptions = {
  isAdmin: boolean;
  platformReady: boolean;
  membership: OrgMembership | undefined;
  hasMemberships: boolean;
  scopeError: boolean;
  go: (to: string, search?: Record<string, string>) => () => void;
  onSwitchOrg: () => void;
  onRetry: () => void;
  setPref: (pref: ThemePref) => void;
};

/** Actions available in the current platform and organization scope. */
export function paletteActions({
  isAdmin,
  platformReady,
  membership,
  hasMemberships,
  scopeError,
  go,
  onSwitchOrg,
  onRetry,
  setPref,
}: PaletteActionOptions): CommandItem[] {
  return [
    {
      id: 'new-pass',
      label: 'New pass',
      icon: Plus,
      onSelect: go('/admin/passes/new'),
      allowed: canAccessAdminPath('/admin/passes/new', isAdmin, membership),
    },
    {
      id: 'upload-template',
      label: 'Upload template',
      icon: Upload,
      onSelect: go('/admin/templates/upload'),
      allowed: canAccessAdminPath('/admin/templates/upload', isAdmin, membership),
    },
    {
      id: 'new-connection',
      label: 'New connection',
      icon: Plus,
      onSelect: go('/admin/connections/new'),
      allowed: canAccessAdminPath('/admin/connections/new', isAdmin, membership),
    },
    {
      id: 'new-org',
      label: 'New organization',
      icon: Plus,
      onSelect: go('/admin/orgs', { new: '1' }),
      allowed: canAccessAdminPath('/admin/orgs', platformReady, membership),
    },
    {
      id: 'new-key',
      label: 'New API key',
      icon: Plus,
      onSelect: go('/admin/api-keys', { new: '1' }),
      allowed: canAccessAdminPath('/admin/api-keys', platformReady, membership),
    },
    {
      id: 'new-scanner',
      label: 'New scanning session',
      icon: ENTITY.scanner.icon,
      onSelect: go('/admin/scanning', { new: '1' }),
      allowed:
        canAccessAdminPath('/admin/scanning', isAdmin, membership) &&
        membership?.capabilities.includes('scanning:manage'),
    },
    {
      id: 'switch-org',
      label: 'Switch organization…',
      icon: ArrowLeftRight,
      onSelect: onSwitchOrg,
      allowed: hasMemberships,
    },
    {
      id: 'retry-org-access',
      label: 'Retry organization access',
      icon: RefreshCw,
      onSelect: onRetry,
      allowed: scopeError,
    },
    ...THEME_OPTIONS.map((t) => ({
      id: `theme:${t.value}`,
      label: `Theme: ${t.label}`,
      icon: THEME_ICON[t.value],
      onSelect: () => setPref(t.value),
      allowed: true,
    })),
  ].filter((item) => item.allowed);
}
