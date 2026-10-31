import type { AuditEntry } from './entry-drawer.tsx';

type Labeled = AuditEntry & { actorLabel?: string | null; targetLabel?: string | null };

/** Display text for the actor; falls back to the raw id. */
export function actorText(e: Labeled): string {
  const who = e.actorLabel ?? e.actorId;
  return who ? `${e.actorType}: ${who}` : e.actorType;
}

/** Display text for the target; falls back to the raw id. Empty when none. */
export function targetText(e: Labeled): string {
  if (!e.targetType) return '';
  const what = e.targetLabel ?? e.targetId;
  return what ? `${e.targetType}: ${what}` : e.targetType;
}
