import type { BroadcastDto, BroadcastKind, BroadcastState } from '@/shared/contracts/broadcasts.ts';
import { formatCount, formatDateTime } from '../../lib/format.ts';

export const KIND_LABEL: Record<BroadcastKind, string> = {
  message: 'Message',
  change: 'Change',
};

export const STATE_FILTERS: readonly [BroadcastState, string][] = [
  ['draft', 'Draft'],
  ['scheduled', 'Scheduled'],
  ['sending', 'Sending'],
  ['sent', 'Sent'],
  ['partial', 'Partial'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
];

export const CLEAR_CHOICES: readonly { value: string; label: string; ms: number | null }[] = [
  { value: 'never', label: 'Keep it', ms: null },
  { value: '1h', label: 'After 1 hour', ms: 3_600_000 },
  { value: '6h', label: 'After 6 hours', ms: 6 * 3_600_000 },
  { value: '1d', label: 'After 1 day', ms: 24 * 3_600_000 },
  { value: '7d', label: 'After 7 days', ms: 7 * 24 * 3_600_000 },
];

export const clearLabel = (ms: number): string =>
  CLEAR_CHOICES.find((c) => c.ms === ms)?.label.replace('After', 'after') ??
  `after ${Math.round(ms / 3_600_000)} hours`;

/** Passes handled so far against the passes targeted. */
export function progressOf(b: BroadcastDto): { done: number; total: number; ratio: number } {
  const { updated, unchanged, failed, targeted } = b.counts;
  const done = Math.min(updated + unchanged + failed, targeted);
  return { done, total: targeted, ratio: targeted === 0 ? 0 : done / targeted };
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** One line of counts, leaving out zeros: "12 updated, 3 unchanged, 1 failed". */
export function countsLine(b: BroadcastDto): string {
  const c = b.counts;
  if (b.state === 'draft' || b.state === 'scheduled' || b.state === 'cancelled') return '';
  const parts = [
    c.updated ? `${formatCount(c.updated)} updated` : '',
    c.unchanged ? `${formatCount(c.unchanged)} unchanged` : '',
    c.failed ? `${formatCount(c.failed)} failed` : '',
  ].filter(Boolean);
  if (parts.length === 0)
    return b.state === 'sending' ? plural(c.targeted, 'pass', 'passes') : 'No passes matched';
  return parts.join(', ');
}

/** When it goes out, or went out. */
export function whenLine(b: BroadcastDto): string {
  if (b.state === 'scheduled' && b.at) return `Goes out ${formatDateTime(b.at)}`;
  if (b.state === 'draft') return 'Not sent';
  if (b.state === 'cancelled') return `Cancelled ${formatDateTime(b.finishedAt)}`;
  if (b.state === 'sending') return `Started ${formatDateTime(b.startedAt)}`;
  return formatDateTime(b.finishedAt ?? b.startedAt);
}

/** Holders get no lock-screen notice: notifying is off, or the message is empty (it clears). */
export const isQuiet = (b: BroadcastDto): boolean =>
  !b.notify || (b.kind === 'message' && !messageText(b).trim());

export const messageText = (b: BroadcastDto): string =>
  b.kind === 'message' ? String(b.patch.message ?? '') : '';

/** Who holds a pass, as the audience filter and the details name it. */
export const HOLDER_LABEL = {
  owned: 'Claimed',
  waiting: 'Not claimed',
  unassigned: 'No holder',
} as const;

/** Why a run stopped, from its error code, with what to do about it. */
export function stopLine(code: string | null): string {
  switch (code) {
    case 'ORG_INACTIVE':
      return 'The organization is not active. Activate it, then send again.';
    case 'CREATOR_REVOKED':
      return 'The key or admin that scheduled it was revoked. Create it again.';
    case 'MESSAGING_UNSUPPORTED':
      return 'A template has no message field. Pick another and send again.';
    default:
      return 'It stopped before every pass was handled. Send again to finish the rest.';
  }
}
