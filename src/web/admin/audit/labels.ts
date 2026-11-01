import type { AuditEntry } from './entry-drawer.tsx';

type Labeled = AuditEntry & { actorLabel?: string | null; targetLabel?: string | null };

const ACTION_LABELS: Record<string, string> = {
  'api_key.create': 'API key created',
  'api_key.revoke': 'API key revoked',
  'auth.sign_in': 'Signed in',
  'auth.sign_out': 'Signed out',
  'connection.breaker_open': 'Connection paused after failures',
  'connection.create': 'Connection created',
  'connection.delete': 'Connection deleted',
  'connection.sync': 'Connection synced',
  'connection.test': 'Connection tested',
  'connection.update': 'Connection updated',
  'connection.webhook_secret': 'Webhook secret rotated',
  'cron.run': 'Scheduled job ran',
  'delivery.dead_letter': 'Delivery failed',
  'holder.assign': 'Holder assigned',
  'holder.attach': 'Holder attached',
  'holder.clear_block': 'Holder block cleared',
  'holder.reassign': 'Holder reassigned',
  'holder.remove': 'Holder removed',
  'holder.unassign': 'Holder unassigned',
  'identity.apns_probe': 'Push connection checked',
  'identity.delete': 'Identity deleted',
  'identity.rotate': 'Identity rotated',
  'identity.update': 'Identity updated',
  'identity.upload': 'Identity uploaded',
  'org.create': 'Organization created',
  'org.delete': 'Organization deleted',
  'org.update': 'Organization updated',
  'pass.asset.delete': 'Pass image removed',
  'pass.asset.put': 'Pass image added',
  'pass.bulk_reissue': 'Passes reissued',
  'pass.create': 'Pass created',
  'pass.delete': 'Pass deleted',
  'pass.personalized': 'Pass personalized',
  'pass.remove_from_user': 'Pass removed from account',
  'pass.resend_email': 'Pass email resent',
  'pass.rotate_link': 'Pass link rotated',
  'pass.update': 'Pass updated',
  'pass.void': 'Pass voided',
  'session.revoke': 'Session revoked',
  'settings.update': 'Settings updated',
  'template.activate': 'Template activated',
  'template.archive': 'Template archived',
  'template.assign_org': 'Template organization changed',
  'template.clone': 'Template cloned',
  'template.delete': 'Template deleted',
  'template.manifest': 'Template manifest changed',
  'template.upload': 'Template uploaded',
  'pass.unvoid': 'Pass restored',
  'user.disable': 'User disabled',
  'user.enable': 'User enabled',
  'user.email_add': 'Email added',
  'user.email_remove': 'Email removed',
  'user.email_verified': 'Email verified',
  'user.sessions_revoke': 'Sessions revoked',
};

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

const humanize = (code: string) => {
  const s = code.replace(/[._]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Sentence for an audit action code; unknown codes are humanized. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanize(action);
}

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
