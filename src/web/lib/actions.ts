import {
  Archive,
  ArrowRightLeft,
  BadgeCheck,
  CircleCheck,
  Clock,
  FlaskConical,
  ImageMinus,
  ImagePlus,
  Link2,
  Lock,
  LogIn,
  type LucideIcon,
  MailCheck,
  MailPlus,
  MailX,
  Pause,
  Play,
  QrCode,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Star,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
} from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

export interface ActionEntry {
  label: string;
  icon: LucideIcon;
  /** success: created or working; info: changed; warning: paused or taken away; danger: lost. */
  tone: Tone;
}

const a = (label: string, icon: LucideIcon, tone: Tone): ActionEntry => ({ label, icon, tone });
const I = ACTION_ICON;

/** Audit and activity vocabulary: a label, a glyph and a tone per action code. */
export const ACTIONS: Record<string, ActionEntry> = {
  'broadcast.cancel': a('Message cancelled', I.void, 'warning'),
  'broadcast.create': a('Message created', ENTITY.broadcast.icon, 'success'),
  'broadcast.send': a('Message sent', I.updateDevices, 'info'),
  'broadcast.update': a('Message edited', I.edit, 'info'),
  'broadcast.retry': a('Message sent again', I.updateDevices, 'info'),
  'api_key.create': a('API key created', ENTITY.apiKey.icon, 'success'),
  'api_key.revoke': a('API key revoked', ENTITY.apiKey.icon, 'warning'),
  'auth.sign_in': a('Signed in', LogIn, 'success'),
  'auth.sign_out': a('Signed out', I.signOut, 'neutral'),
  'connection.breaker_open': a('Connection paused after failures', Pause, 'warning'),
  'connection.create': a('Connection created', ENTITY.connection.icon, 'success'),
  'connection.delete': a('Connection deleted', I.delete, 'danger'),
  'connection.sync': a('Connection synced', I.refresh, 'success'),
  'connection.test': a('Connection tested', I.test, 'info'),
  'connection.update': a('Connection updated', I.edit, 'info'),
  'connection.webhook_secret': a('Webhook secret rotated', I.rotate, 'info'),
  'cron.run': a('Scheduled job ran', Clock, 'neutral'),
  'delivery.dead_letter': a('Delivery failed', MailX, 'danger'),
  'holder.assign': a('Holder assigned', UserPlus, 'success'),
  'holder.attach': a('Holder attached', UserCheck, 'success'),
  'holder.clear_block': a('Holder block cleared', ShieldCheck, 'info'),
  'holder.reassign': a('Holder reassigned', ArrowRightLeft, 'info'),
  'holder.remove': a('Holder removed', UserMinus, 'warning'),
  'holder.unassign': a('Holder unassigned', UserX, 'neutral'),
  'identity.apns_probe': a('Push connection checked', I.recheck, 'info'),
  'identity.delete': a('Identity deleted', I.delete, 'danger'),
  'identity.rotate': a('Identity rotated', I.rotate, 'info'),
  'identity.update': a('Identity updated', I.edit, 'info'),
  'identity.upload': a('Identity uploaded', ENTITY.identity.icon, 'success'),
  'org.create': a('Organization created', ENTITY.org.icon, 'success'),
  'org.delete': a('Organization deleted', I.delete, 'danger'),
  'org.reactivate': a('Organization reactivated', Play, 'success'),
  'org.suspend': a('Organization suspended', Pause, 'warning'),
  'org.update': a('Organization updated', I.edit, 'info'),
  'pass.asset.delete': a('Pass image removed', ImageMinus, 'neutral'),
  'pass.asset.put': a('Pass image added', ImagePlus, 'success'),
  'pass.bulk_reissue': a('Passes reissued', I.updateDevices, 'info'),
  'pass.bind': a('Pass bound to connection', ENTITY.connection.icon, 'info'),
  'pass.create': a('Pass created', ENTITY.pass.icon, 'success'),
  'pass.delete': a('Pass deleted', I.delete, 'danger'),
  'pass.personalized': a('Pass personalized', BadgeCheck, 'success'),
  'pass.remove': a('Pass removed from Wallet', I.removeFromWallet, 'warning'),
  'pass.remove_from_user': a('Pass removed from account', UserMinus, 'warning'),
  'pass.restore': a('Pass restored to Wallet', I.restoreToWallet, 'success'),
  'pass.resend_email': a('Pass email resent', I.sendEmail, 'info'),
  'pass.rotate_link': a('Pass link rotated', I.rotate, 'info'),
  'pass.unvoid': a('Pass restored', I.unvoid, 'success'),
  'pass.unbind': a('Pass unbound from connection', ENTITY.connection.icon, 'neutral'),
  'pass.update': a('Pass updated', I.edit, 'info'),
  'pass.void': a('Pass voided', I.void, 'warning'),
  'scanner.create': a('Scanner created', ENTITY.scanner.icon, 'success'),
  'scanner.update': a('Scanner changed', I.edit, 'info'),
  'scanner.pairing_create': a('Pairing code made', QrCode, 'info'),
  'scanner.pair': a('Scanner paired', ENTITY.scanner.icon, 'success'),
  'scanner.unpair': a('Scanner unpaired', ENTITY.scanner.icon, 'neutral'),
  'scanner.pair_failed': a('Pairing refused after wrong codes', ShieldAlert, 'warning'),
  'scanner.revoke': a('Scanner revoked', ENTITY.scanner.icon, 'warning'),
  'scanner.mode_change': a('Scanner mode changed', FlaskConical, 'info'),
  'scanner.token_replace': a('Scanner token replaced', I.rotate, 'info'),
  'scan_staff.pin_locked': a('PIN locked after 5 tries', Lock, 'warning'),
  'scanner.pin_flood': a('Scanner PINs locked after 20 tries', Lock, 'warning'),
  'sandbox.send_to_me': a('Test email sent to admin', I.sendEmail, 'info'),
  'session.revoke': a('Session revoked', I.signOut, 'warning'),
  'settings.update': a('Settings updated', Settings, 'info'),
  'template.activate': a('Template activated', CircleCheck, 'success'),
  'template.archive': a('Template archived', Archive, 'neutral'),
  'template.assign_org': a('Template organization changed', ENTITY.org.icon, 'info'),
  'template.clone': a('Template duplicated', I.duplicate, 'success'),
  'template.delete': a('Template deleted', I.delete, 'danger'),
  'template.manifest': a('Template manifest changed', I.edit, 'info'),
  'template.restore': a('Template restored', I.restore, 'success'),
  'template.upload': a('Template uploaded', ENTITY.template.icon, 'success'),
  'auth.breakglass_failed': a('Break-glass sign-in failed', ShieldAlert, 'danger'),
  'auth.breakglass_used': a('Break-glass sign-in', ShieldAlert, 'warning'),
  'auth.denied': a('Access denied', ShieldX, 'warning'),
  'auth.identity_linked': a('Sign-in method linked', Link2, 'info'),
  'bundle.create': a('Bundle created', ENTITY.bundle.icon, 'success'),
  'bundle.delete': a('Bundle deleted', I.delete, 'danger'),
  'bundle.rotate_link': a('Bundle link rotated', I.rotate, 'info'),
  'bundle.send_email': a('Bundle email sent', I.sendEmail, 'info'),
  'identity.expired': a('Identity expired', Clock, 'danger'),
  'identity.expiring': a('Identity expiring', Clock, 'warning'),
  'identity.push_key_remove': a('Push key removed', I.pushKey, 'warning'),
  'identity.push_key_rotate': a('Push key rotated', I.rotate, 'info'),
  'identity.push_key_set': a('Push key set', I.pushKey, 'success'),
  'template.version': a('Template version added', ENTITY.version.icon, 'info'),
  'user.disable': a('User disabled', UserX, 'warning'),
  'user.email_add': a('Email added', MailPlus, 'success'),
  'user.email_primary': a('Primary email changed', Star, 'info'),
  'user.email_remove': a('Email removed', MailX, 'neutral'),
  'user.email_verified': a('Email verified', MailCheck, 'success'),
  'user.enable': a('User enabled', UserCheck, 'success'),
  'user.sessions_revoke': a('Sessions revoked', I.signOut, 'warning'),
};

export const humanize = (code: string) => {
  const s = code.replace(/[._]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Sentence for an audit action code; unknown codes are humanized. */
export function actionLabel(action: string): string {
  return ACTIONS[action]?.label ?? humanize(action);
}

/** Label, glyph and tone; unknown codes get the audit glyph in neutral. */
export function actionOf(action: string): ActionEntry {
  return ACTIONS[action] ?? a(humanize(action), ENTITY.audit.icon, 'neutral');
}
