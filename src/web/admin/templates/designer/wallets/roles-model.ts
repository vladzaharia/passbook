/** The role table's rows, from the compiled view and the draft's `wallets.roles`. No rule is copied. */
import { WALLET_CAPABILITIES } from '@/generated/wallet-capabilities.ts';
import type { WalletRoleSource } from '@/passkit/template/wallets/schema.ts';
import {
  type RoleValue,
  WALLET_ROLES,
  type WalletPassView,
  type WalletRole,
} from '@/passkit/wallets/types.ts';
import { ROLE_LABEL, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { type Proposal, proposeRoles } from './proposals.ts';

export type WalletName = 'google' | 'samsung';
type Support = 'native' | 'text' | 'difference' | 'omitted' | 'unsupported';

export type SourceKind = 'auto' | 'field' | 'value' | 'empty';

export interface RoleRow {
  role: WalletRole;
  label: string;
  /** How the author set it: not at all, a field, a value, or left empty. */
  kind: SourceKind;
  authored: WalletRoleSource | undefined;
  resolved: RoleValue | undefined;
  /** The sample value, `—` when empty. */
  value: string;
  /** Apple semantics, Style default or Set here. */
  provenance: string | null;
  required: boolean;
  /** A line in danger text under the row. */
  problem: string | null;
  proposal: Proposal | null;
  group: 'own' | 'text' | 'none';
}

const CAPS = WALLET_CAPABILITIES as unknown as Record<
  string,
  Record<string, Record<string, Support>>
>;

/** The support level of a role on the wallet's compiled type. */
export function supportOf(target: WalletName, type: string, role: WalletRole): Support | undefined {
  return CAPS[target]?.[type]?.[`role.${role}`];
}

export function valueText(v: RoleValue | undefined): string {
  if (!v) return '—';
  switch (v.kind) {
    case 'text':
      return v.text;
    case 'date':
      return v.iso;
    case 'number':
      return v.text;
    case 'money':
      return `${v.amount} ${v.currencyCode}`;
    case 'location':
      return `${v.latitude}, ${v.longitude}`;
    case 'channel':
      return v.channel;
    case 'url':
      return v.url;
    case 'app':
      return v.name ?? v.url ?? '—';
    case 'links':
      return v.links.map((l) => l.text ?? l.url).join(', ');
  }
}

const PROVENANCE = {
  manifest: WALLETS_COPY.roles.set,
  semantics: WALLETS_COPY.roles.semantics,
  style: WALLETS_COPY.roles.style,
} as const;

export function sourceKind(source: WalletRoleSource | undefined): SourceKind {
  if (source === undefined) return 'auto';
  if (source === false) return 'empty';
  return 'field' in source ? 'field' : 'value';
}

/** Roles that read the same Apple field on this wallet, with the first of each pair named. */
function duplicatesOf(view: WalletPassView, target: WalletName, type: string) {
  const owner = new Map<string, WalletRole>();
  const twice = new Map<WalletRole, WalletRole>();
  for (const role of WALLET_ROLES) {
    const value = view.roles[role];
    if (!value || supportOf(target, type, role) !== 'native') continue;
    for (const path of value.fields) {
      const first = owner.get(path);
      if (first) twice.set(first, role);
      else owner.set(path, role);
    }
  }
  return twice;
}

/** The rows for one wallet at its compiled type, in WALLET_ROLES order. */
export function roleRows(
  view: WalletPassView,
  target: WalletName,
  type: string,
  authoredRoles: Partial<Record<WalletRole, WalletRoleSource>> | undefined,
  required: readonly string[],
): { rows: RoleRow[]; proposals: Proposal[] } {
  const twice = duplicatesOf(view, target, type);
  const proposals = proposeRoles(view, authoredRoles, new Set(twice.keys()));
  const byRole = new Map(proposals.map((p) => [p.role, p]));
  const rows = WALLET_ROLES.map((role): RoleRow => {
    const resolved = view.roles[role];
    const authored = authoredRoles?.[role];
    const note = view.notes.find((n) => n.subject === role);
    const other = twice.get(role);
    const proposal = byRole.get(role) ?? null;
    const native = supportOf(target, type, role) === 'native';
    return {
      role,
      label: ROLE_LABEL[role],
      kind: sourceKind(authored),
      authored,
      resolved,
      value: valueText(resolved),
      provenance: resolved ? PROVENANCE[resolved.source] : null,
      required: required.includes(`role.${role}`),
      problem: other
        ? WALLETS_COPY.roles.twice.replace('{role}', ROLE_LABEL[other])
        : (note?.message ?? null),
      proposal,
      group: native ? 'own' : resolved || proposal ? 'text' : 'none',
    };
  });
  return { rows, proposals };
}
