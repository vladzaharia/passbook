import type { z } from 'zod';
import type { IdentityStatus, WalletIdentitySchema } from '@/shared/contracts/identities.ts';
import { formatDay } from '@/web/lib/format.ts';
import { StatusPill } from '@/web/ui/index.ts';

type Row = Pick<z.infer<typeof WalletIdentitySchema>, 'rotation' | 'nextRotationAt' | 'kind'>;

const PILL: Record<IdentityStatus, { status: string; label: string }> = {
  active: { status: 'verified', label: 'Active' },
  renewing: { status: 'running', label: 'Renewing' },
  expiring: { status: 'expiring', label: 'Expiring' },
  expired: { status: 'failed', label: 'Expired' },
  retired: { status: 'disabled', label: 'Retired' },
  failed: { status: 'failed', label: 'Failed' },
  provisioning: { status: 'queued', label: 'Setting up' },
};

export const STATUS_OPTIONS = (Object.keys(PILL) as IdentityStatus[]).map((value) => ({
  value,
  label: PILL[value].label,
}));

export const KIND_LABEL = { platform: 'Platform', managed: 'Managed', own: 'Own' } as const;

export function IdentityStatusPill({ status }: { status: IdentityStatus }) {
  const p = PILL[status];
  return <StatusPill status={p.status}>{p.label}</StatusPill>;
}

/** The renewal column: the date automatic renewal starts, or Manual. */
export function renewalText(row: Row): string {
  if (row.rotation !== 'auto') return row.kind === 'platform' ? 'Environment' : 'Manual';
  return row.nextRotationAt === null ? 'Auto' : formatDay(row.nextRotationAt);
}
