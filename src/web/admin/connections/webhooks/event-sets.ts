import { SUBSCRIBABLE_EVENT_TYPES } from '@/shared/contracts/webhooks.ts';
import type { SubscribableEventType } from './form-state.ts';

/** Quick picks: each replaces the ticked events with its set. */
export const EVENT_SETS: readonly {
  id: string;
  label: string;
  types: readonly SubscribableEventType[];
}[] = [
  { id: 'all', label: 'All', types: SUBSCRIBABLE_EVENT_TYPES },
  {
    id: 'changes',
    label: 'Pass changes',
    types: [
      'pass.issued',
      'pass.updated',
      'pass.voided',
      'pass.unvoided',
      'pass.removed',
      'pass.restored',
      'pass.channels_changed',
    ],
  },
  { id: 'wallet', label: 'Wallet activity', types: ['pass.installed', 'pass.uninstalled'] },
  { id: 'scans', label: 'Scans', types: ['pass.scanned', 'pass.scan_refused', 'pass.scan_undone'] },
  { id: 'delivery', label: 'Delivery', types: ['push.failed', 'email.failed'] },
  { id: 'printing', label: 'Printing', types: ['pass.printed', 'pass.print_voided'] },
];

/** The set the ticked events equal exactly, if any. */
export const setOf = (ticked: readonly string[]) =>
  EVENT_SETS.find(
    (s) => s.types.length === ticked.length && s.types.every((t) => ticked.includes(t)),
  );
