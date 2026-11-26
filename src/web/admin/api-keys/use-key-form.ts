import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { useToolMode } from '@/web/lib/tool-api.tsx';
import { ROLE_LABELS, ROLES } from '../orgs/org-roles.ts';
import { isIpOrCidr, splitIps } from './cidr.ts';
import { EXPIRY, SHORT_EXPIRY } from './key-kind-fields.ts';
import { useKeysHost } from './keys-host.tsx';
import { useKeyScopes } from './use-key-scopes.ts';

/** The least a key can do; more is ticked on purpose. */
const DEFAULT_SCOPES = ['passes:read'];

export const STEPS = [
  { id: 'basics', title: 'Basics', heading: 'Name the key' },
  { id: 'access', title: 'Access', heading: 'What it can do' },
  { id: 'limits', title: 'Limits', heading: 'Where it works' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

/** Why Next is off, by step. */
export const HINTS: Partial<Record<StepId, string>> = {
  basics: 'Name the key.',
  access: 'Pick access.',
  limits: 'Fix the IPs.',
};

/** Where a server field error is fixed. */
export const FIELD_STEP: Record<string, StepId> = {
  name: 'basics',
  orgId: 'basics',
  kind: 'basics',
  expiresAt: 'basics',
  scopes: 'access',
  roles: 'access',
  terminalIds: 'access',
  ipAllow: 'limits',
  mode: 'limits',
};

/** Everything the New API key wizard collects, with each step's errors. */
export function useKeyForm(
  open: boolean,
  orgId: string | null,
  capabilities: readonly OrgCapability[] | null,
  developerOrg: boolean,
) {
  const cap = useKeysHost()?.cap;
  const toolMode = useToolMode();
  const dflt = cap ? String(cap.maxDays) : '90';
  const picked = useKeyScopes(DEFAULT_SCOPES, orgId, capabilities, developerOrg);
  const { scopes } = picked;
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState(dflt);
  const [kind, setKind] = useState<'service' | 'personal'>('service');
  const [access, setAccess] = useState('scopes');
  const [custom, setCustom] = useState(false);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const [ips, setIps] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  // An organization key takes the console's mode, shown without a choice. Platform pages ignore
  // mode, so a platform key's mode is chosen here.
  const [keyMode, setKeyMode] = useState<Mode>(toolMode);
  useEffect(() => {
    if (open) setKeyMode(toolMode);
  }, [open, toolMode]);

  const role = ROLES.find((r) => r === access);
  const scansWrite = scopes.includes('scans:write') && !role;
  const short = orgId === null || kind === 'personal';
  // A host's cap keeps the choices within its days; a short-lived kind within 90.
  const expiryOptions = cap
    ? EXPIRY.filter((o) => o.value !== 'never' && Number(o.value) <= cap.maxDays)
    : short
      ? SHORT_EXPIRY
      : EXPIRY;
  // A short-lived kind falls back to 90 days when the longer choice was picked first.
  const days = expiryOptions.some((o) => o.value === expiry) ? expiry : dflt;
  const drafted = splitIps(draft);
  const badDraft = drafted.some((t) => !isIpOrCidr(t));
  const ipAllow = [...ips, ...(badDraft ? [] : drafted.filter((t) => !ips.includes(t)))];

  const errors = {
    basics: name.trim() ? undefined : { name: 'Required.' },
    access:
      role || scopes.length
        ? scansWrite && orgId !== null && !terminalIds.length
          ? { terminalIds: 'Pick at least one terminal.' }
          : undefined
        : { scopes: 'Pick at least one scope.' },
    limits: badDraft
      ? { ipAllow: 'Not an IP address or range.' }
      : orgId === null && !ipAllow.length
        ? { ipAllow: 'Required for a platform key.' }
        : undefined,
  } as const;

  function reset() {
    picked.reset();
    setName('');
    setExpiry(dflt);
    setKind('service');
    setAccess('scopes');
    setCustom(false);
    setTerminalIds([]);
    setIps([]);
    setDraft('');
    setKeyMode(toolMode);
  }

  return {
    ...picked,
    name,
    setName,
    expiry: days,
    expiryOptions,
    cap,
    setExpiry,
    kind,
    changeKind(next: 'service' | 'personal') {
      setKind(next);
      picked.reconcile(next, keyMode);
    },
    access,
    setAccess,
    role,
    custom,
    setCustom,
    terminalIds,
    setTerminalIds,
    scansWrite,
    ips,
    setIps,
    draft,
    setDraft,
    ipAllow,
    keyMode,
    changeMode(next: Mode) {
      setKeyMode(next);
      picked.reconcile(kind, next);
    },
    short,
    errors,
    dirty:
      name.trim() !== '' ||
      scopes.join() !== DEFAULT_SCOPES.join() ||
      expiry !== dflt ||
      kind !== 'service' ||
      access !== 'scopes' ||
      ips.length > 0 ||
      draft !== '',
    reset,
  };
}
export type KeyForm = ReturnType<typeof useKeyForm>;

/** What was chosen, under a done step on the rail. */
export function keySummaries(form: KeyForm): Record<StepId, string | undefined> {
  return {
    basics: form.name.trim(),
    access: form.role
      ? ROLE_LABELS[form.role]
      : `${form.scopes.length} scope${form.scopes.length === 1 ? '' : 's'}`,
    limits: form.ipAllow.length
      ? `${form.ipAllow.length} IP${form.ipAllow.length === 1 ? '' : 's'}`
      : 'Any IP',
    review: undefined,
  };
}
