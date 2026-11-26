/** The ways out of a Blocked report: go to the thing that blocks it, or stop requiring it. */

import type { WalletRole } from '@/passkit/template/wallets/schema.ts';
import { unmetNeeds } from '@/passkit/wallets/type-needs.ts';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import { capabilityLabel, ROLE_LABEL, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import type { Op } from '../apply.ts';
import type { Selection } from '../model.ts';
import { requiredOf, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.report;

export type Fix = { label: string } & ({ go: Selection } | { op: Op });

/** Where the author sets what a capability reads from. */
export function selectionFor(capability: string, target: WalletEnv['target']): Selection | null {
  if (capability.startsWith('role.')) return { section: 'wallets-roles', key: capability.slice(5) };
  if (capability === 'type') return { section: 'wallets-type' };
  if (capability.startsWith('barcode')) return { section: 'barcode' };
  if (capability === 'image.logo') return { section: 'wallets-images', key: `${target}:logo` };
  if (capability.startsWith('image.')) return { section: 'wallets-images' };
  if (capability.startsWith('colors.')) return { section: 'colors' };
  return null;
}

/** Fixes for the focused wallet's Blocked state, by what blocks it. */
export function blockedFixes(env: WalletEnv, report: FidelityReportDto): Fix[] {
  const { out, block, target } = env;
  if (report.status.kind !== 'blocked') return [];
  const required = requiredOf(block);
  const stop = (id: string): Fix => ({
    label: C.dontRequire.replace('{label}', capabilityLabel(id)),
    op: { op: 'wallets-required', id, on: false },
  });
  const code = out.compiled.blocked?.code;
  if (code === 'CLASS_FIELDS_VARY')
    return [{ label: C.setClass, go: { section: 'wallets-type', key: 'classKey' } }];
  if (code === 'IDENTITY_TOO_LONG')
    return [{ label: C.goTo.replace('{label}', 'Roles'), go: { section: 'wallets-roles' } }];
  const emptyRole = required.find(
    (id) => id.startsWith('role.') && !out.view.roles[id.slice(5) as WalletRole],
  );
  if (code === 'REQUIRED_ROLE_EMPTY' && emptyRole) {
    const role = emptyRole.slice(5) as WalletRole;
    return [
      {
        label: C.goTo.replace('{label}', ROLE_LABEL[role]),
        go: { section: 'wallets-roles', key: role },
      },
      stop(emptyRole),
    ];
  }
  const type = out.compiled.type;
  if (code === 'TYPE_UNSATISFIED' && required.includes('type')) {
    const need = unmetNeeds(target, type, out.view)[0];
    const fixes: Fix[] = [];
    if (need?.kind === 'role')
      fixes.push({
        label: C.goTo.replace('{label}', ROLE_LABEL[need.role]),
        go: { section: 'wallets-roles', key: need.role },
      });
    return [...fixes, stop('type')];
  }
  const item = report.items.find((i) => i.severity === 'blocked');
  if (item) {
    const go = selectionFor(item.capability, target);
    const id =
      required.find((r) => item.capability === r || item.capability.startsWith(`${r}.`)) ??
      item.capability;
    return [
      ...(go ? [{ label: C.goTo.replace('{label}', capabilityLabel(item.capability)), go }] : []),
      stop(id),
    ];
  }
  return [];
}
