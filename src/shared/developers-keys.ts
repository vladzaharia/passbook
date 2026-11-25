import {
  auditScopeAllowed,
  MINTABLE_SCOPES,
  TEMPLATE_ACT_AS_SCOPES,
  TEST_ONLY_SCOPES,
} from './contracts/api-keys.ts';
import type { Mode } from './contracts/common.ts';
import { SANDBOX_KEY_SCOPES } from './contracts/developer-home.ts';
import type { OrgCapability } from './contracts/org-membership.ts';

/**
 * What a key is for, as scopes. One map for the portal's New key sheet and Admin's scope list: a preset is only
 * offered when every scope in it fits under the ceiling the caller holds.
 */
export const KEY_PRESETS = [
  { id: 'issue', label: 'Issue passes', scopes: ['passes:read', 'passes:write', 'templates:read'] },
  {
    id: 'read',
    label: 'Read only',
    scopes: ['passes:read', 'templates:read', 'scans:read', 'connections:read'],
  },
  { id: 'webhooks', label: 'Webhooks', scopes: ['webhooks:manage'] },
  {
    id: 'support',
    label: 'Holder support',
    scopes: ['passes:read', 'holders:write', 'messages:write'],
  },
  {
    id: 'messages',
    label: 'Messages',
    scopes: ['messages:write', 'passes:read', 'templates:read'],
  },
  {
    id: 'sync',
    label: 'Import and sync',
    scopes: [
      'connections:read',
      'connections:write',
      'passes:read',
      'passes:write',
      'holders:write',
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    scopes: ['connections:read', 'connections:write', 'webhooks:manage'],
  },
  { id: 'templates', label: 'Template authoring', scopes: ['templates:read', 'templates:write'] },
  /** Review and publish work in Test only: a Live key may request review, never release. */
  {
    id: 'release',
    label: 'Release templates',
    scopes: ['templates:read', 'templates:write', 'templates:review', 'templates:publish'],
  },
  /** Reads the organization's audit log: a Live key (or a sandbox key); a key never gets it from a role. */
  { id: 'audit', label: 'Audit', scopes: ['audit:read'] },
  { id: 'brand', label: 'Brand', scopes: ['brand:manage', 'org:read'] },
  {
    id: 'scanner-setup',
    label: 'Scanner setup',
    scopes: ['scanning:write', 'scan-setup:read', 'scans:read'],
  },
  /** Acts as terminals the key is bound to, so only an organization service key holds it. */
  { id: 'till', label: 'Till', scopes: ['scans:write', 'scans:read', 'passes:read'] },
] as const;
export type KeyPresetId = (typeof KEY_PRESETS)[number]['id'];

/** The portal adds the whole ceiling to the presets: every scope a sandbox key may hold. */
export const FULL_SANDBOX = { id: 'full', label: 'Full sandbox' } as const;

/**
 * Admin's last preset: everything a key can hold except key minting, the terminal scope, the credential scopes and the
 * audit log (those are ticked on purpose, never by a preset), and, in Live, the Test-only scopes.
 */
export function fullAccess(mode: Mode) {
  return {
    id: 'full',
    label: 'Full access',
    scopes: SANDBOX_KEY_SCOPES.filter(
      (s) => s !== 'audit:read' && (mode === 'test' || !isTestOnly(s)),
    ),
  } as const;
}

const isTestOnly = (s: string) => (TEST_ONLY_SCOPES as readonly string[]).includes(s);
const ORG_ONLY: readonly string[] = [
  'org:write',
  'wallet:write',
  'audit:read',
  'nfc:read',
  'nfc:write',
  ...TEMPLATE_ACT_AS_SCOPES,
];

/** The capability each mintable scope exercises (`scopeCapability` in the Worker; a test keeps them equal). */
export const MINTABLE_SCOPE_CAPABILITY: Record<(typeof MINTABLE_SCOPES)[number], OrgCapability> = {
  'passes:read': 'passes:read',
  'passes:write': 'passes:operate',
  'holders:write': 'passes:operate',
  'templates:read': 'templates:read',
  'templates:write': 'templates:author',
  'templates:review': 'templates:review',
  'templates:publish': 'templates:publish',
  'messages:write': 'messages:manage',
  'scans:read': 'scanning:read',
  'scans:write': 'passes:operate',
  'connections:read': 'integrations:read',
  'connections:write': 'integrations:manage',
  'webhooks:manage': 'integrations:manage',
  'brand:manage': 'org:manage',
  'org:read': 'org:read',
  'org:write': 'org:manage',
  'wallet:write': 'integrations:manage',
  'scanning:write': 'scanning:manage',
  'scan-setup:read': 'scanning:read',
  'scanning:admin': 'scanning:manage',
  'nfc:keys': 'scanning:manage',
  'nfc:read': 'passes:read',
  'nfc:write': 'passes:operate',
  'api-keys:write': 'integrations:manage',
  'audit:read': 'audit:read',
};

/**
 * The scopes a key of this kind and mode may hold for this creator: a personal or platform key never takes the terminal
 * scope, a platform key none of an organization's setup, template or audit scopes, a Live key neither review nor release,
 * a Test key no audit log, and a member's key never exceeds their capabilities (`null`: a platform admin, no cap).
 */
export function holdableScopes(
  kind: 'service' | 'personal' | 'platform',
  capabilities: readonly OrgCapability[] | null,
  mode: Mode = 'live',
  developerOrg = false,
): string[] {
  return MINTABLE_SCOPES.filter(
    (s) =>
      (kind === 'service' || s !== 'scans:write') &&
      (kind !== 'platform' || !ORG_ONLY.includes(s)) &&
      (mode === 'test' || !isTestOnly(s)) &&
      (s !== 'audit:read' || auditScopeAllowed(mode, developerOrg)) &&
      (capabilities === null || capabilities.includes(MINTABLE_SCOPE_CAPABILITY[s])),
  );
}

/** Admin's presets for a key: those the creator can hold, then Full access when all of it fits. */
export function adminPresets(ceiling: readonly string[], mode: Mode = 'live') {
  const all = presetsWithin(ceiling);
  const full = fullAccess(mode);
  return full.scopes.every((s) => ceiling.includes(s)) ? [...all, full] : all;
}

/** The preset whose scopes are exactly `scopes` (any order), else null. */
export function selectedPreset<P extends { scopes: readonly string[] }>(
  presets: readonly P[],
  scopes: readonly string[],
): P | null {
  return (
    presets.find(
      (p) => p.scopes.length === scopes.length && p.scopes.every((s) => scopes.includes(s)),
    ) ?? null
  );
}

/** Expiry choices for a personal key (the server's limit is 90 days). */
export const KEY_EXPIRY_DAYS = [1, 7, 14, 30, 60, 90] as const;

/** A roll keeps the old key working this long beside the new one. */
export const ROLL_OVERLAP_HOURS = 1;

/** The presets whose scopes all fit under `ceiling`. */
export function presetsWithin(ceiling: readonly string[]) {
  return KEY_PRESETS.filter((p) => p.scopes.every((s) => ceiling.includes(s)));
}

/** The scopes a sandbox key may hold, in the contract's order. */
export const SANDBOX_CEILING: readonly string[] = SANDBOX_KEY_SCOPES;

/** The preset a set of scopes equals, else null (Pick scopes). Order does not matter. */
export function presetOf(
  scopes: readonly string[],
  ceiling: readonly string[] = SANDBOX_CEILING,
): string | null {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((s) => b.includes(s));
  const hit = presetsWithin(ceiling).find((p) => same(p.scopes, scopes));
  if (hit) return hit.label;
  return same(ceiling, scopes) ? FULL_SANDBOX.label : null;
}

/** The line a developer pastes: the key, as an environment variable. */
export const envLine = (secret: string): string => `PASSBOOK_KEY=${secret}`;
