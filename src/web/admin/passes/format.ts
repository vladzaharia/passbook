export { formatDateTime as formatDate } from '../../lib/format.ts';

export function newKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `k-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

/** Stable JSON for fingerprints: same inputs give the same string. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

const ACTION_LABELS: Record<string, string> = {
  'delivery.dead_letter': 'Delivery failed',
  'holder.assign': 'Holder assigned',
  'holder.attach': 'Holder attached',
  'holder.clear_block': 'Block cleared',
  'holder.reassign': 'Holder reassigned',
  'holder.remove': 'Holder removed',
  'holder.unassign': 'Holder unassigned',
  'pass.asset.delete': 'Image removed',
  'pass.asset.put': 'Image uploaded',
  'pass.bulk_reissue': 'Reissued in bulk',
  'pass.create': 'Pass created',
  'pass.delete': 'Pass deleted',
  'pass.personalized': 'Pass personalized',
  'pass.remove_from_user': 'Removed by holder',
  'pass.resend_email': 'Email resent',
  'pass.rotate_link': 'Link rotated',
  'pass.update': 'Pass updated',
  'pass.void': 'Void changed',
};

/** Readable name of an audit action code; unknown codes are spaced out. */
export function actionLabel(code: string): string {
  const known = ACTION_LABELS[code];
  if (known) return known;
  const text = code.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}
