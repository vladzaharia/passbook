import { type LucideIcon, Pause } from 'lucide-react';
import { ACTION_ICON as I } from './action-icons.ts';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Stopping a sending run, undoing a change run, and the automatic message rules. */
export const BROADCAST_RUN_ACTIONS = {
  'broadcast.stop': a('Message stopped', I.void, 'warning'),
  'broadcast.undo': a('Change undone', I.restore, 'warning'),
  'message_rule.create': a('Message rule created', ENTITY.broadcast.icon, 'success'),
  'message_rule.update': a('Message rule edited', I.edit, 'info'),
  'message_rule.pause': a('Message rule paused', Pause, 'warning'),
  'message_rule.delete': a('Message rule deleted', I.delete, 'danger'),
  'message_rule.test': a('Message rule tested', I.test, 'info'),
};
