import { humanize } from '@/web/lib/actions.ts';
import type { AuditEntry } from './entry-drawer.tsx';

type Labeled = AuditEntry & { actorLabel?: string | null; targetLabel?: string | null };

const TARGET_LABELS: Record<string, string> = {
  api_key: 'API key',
  connection: 'Connection',
  identity: 'Identity',
  org: 'Organization',
  pass: 'Pass',
  settings: 'Settings',
  template: 'Template',
  template_import: 'Template import',
  user: 'User',
  session: 'Session',
  holder: 'Holder',
};

const ACTOR_LABELS: Record<string, string> = {
  user: 'User',
  api_key: 'API key',
  system: 'System',
  connection: 'Connection',
  device: 'Device',
};

export function targetTypeLabel(type: string): string {
  return TARGET_LABELS[type] ?? humanize(type);
}

/** Display text for the actor; falls back to the raw id. */
export function actorText(e: Labeled): string {
  const type = ACTOR_LABELS[e.actorType] ?? humanize(e.actorType);
  const who = e.actorLabel ?? e.actorId;
  return who ? `${type}: ${who}` : type;
}

/** Display text for the target; falls back to the raw id. Empty when none. */
export function targetText(e: Labeled): string {
  if (!e.targetType) return '';
  const type = targetTypeLabel(e.targetType);
  const what = e.targetLabel ?? e.targetId;
  return what ? `${type}: ${what}` : type;
}
