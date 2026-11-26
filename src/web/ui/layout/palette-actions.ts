import { ArrowLeftRight, Plus, RefreshCw, Upload } from 'lucide-react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { THEME_ICON } from '../../lib/action-icons.ts';
import { ENTITY } from '../../lib/entities.ts';
import { canAccessAdminPath } from '../../lib/guards.ts';
import { orgPath, platformPath } from '../../lib/scope.ts';
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
  // Organization actions act in the organization the page is in.
  const org = (rest: string) => (membership ? orgPath(membership.orgId, rest) : undefined);
  const can = (path: string | undefined) =>
    path !== undefined && canAccessAdminPath(path, isAdmin, membership);
  const open = (path: string | undefined, search?: Record<string, string>) =>
    go(path ?? '/admin', search);
  return [
    {
      id: 'new-pass',
      label: 'New pass',
      icon: Plus,
      onSelect: open(org('/passes/new')),
      allowed: can(org('/passes/new')),
    },
    {
      id: 'upload-template',
      label: 'Upload template',
      icon: Upload,
      onSelect: open(org('/templates/upload')),
      allowed: can(org('/templates/upload')),
    },
    {
      id: 'new-connection',
      label: 'New connection',
      icon: Plus,
      onSelect: open(org('/connections/new')),
      allowed: can(org('/connections/new')) && !membership?.testOnly,
    },
    {
      id: 'new-org',
      label: 'New organization',
      icon: Plus,
      onSelect: go(platformPath('/orgs'), { new: '1' }),
      allowed: platformReady,
    },
    {
      id: 'new-key',
      label: 'New API key',
      icon: Plus,
      onSelect: open(membership ? org('/api-keys') : platformPath('/api-keys'), { new: '1' }),
      allowed: membership ? can(org('/api-keys')) : platformReady,
    },
    {
      id: 'new-scanner',
      label: 'New session',
      icon: ENTITY.scanner.icon,
      onSelect: open(org('/scanning'), { new: '1' }),
      allowed: can(org('/scanning')) && membership?.capabilities.includes('scanning:manage'),
    },
    {
      id: 'switch-org',
      label: 'Switch scope…',
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
