import type { BroadcastKind, BroadcastTarget } from '@/shared/contracts/broadcasts.ts';
import type { DateTimeValue } from '../../ui/index.ts';
import { localToIso } from '../passes/schema-form/datetime.ts';
import type { FormValues } from '../passes/schema-form/index.ts';
import type { NewBroadcast } from './api.ts';
import { CLEAR_CHOICES } from './labels.ts';

export type HolderChoice = 'any' | 'owned' | 'waiting' | 'unassigned';

export interface ComposerState {
  kind: BroadcastKind;
  templateIds: string[];
  onDevice: boolean;
  holder: HolderChoice;
  q: string;
  message: string;
  /** Clear the current message instead of writing one. */
  clearing: boolean;
  notify: boolean;
  clear: string;
  /** Inputs a change sets, and their values. */
  fields: string[];
  values: FormValues;
  when: 'now' | 'later';
  at: DateTimeValue | null;
}

export const INITIAL: ComposerState = {
  kind: 'message',
  templateIds: [],
  onDevice: false,
  holder: 'any',
  q: '',
  message: '',
  clearing: false,
  notify: true,
  clear: 'never',
  fields: [],
  values: {},
  when: 'now',
  at: null,
};

export function targetOf(s: ComposerState): BroadcastTarget | undefined {
  if (s.templateIds.length === 0) return undefined;
  return {
    templateIds: s.templateIds,
    ...(s.onDevice ? { onDevice: true } : {}),
    ...(s.holder !== 'any' ? { holderState: s.holder } : {}),
    ...(s.q.trim() ? { q: s.q.trim() } : {}),
  };
}

/** The send time in epoch ms, or undefined while it is empty or unreadable. */
export function atMs(s: ComposerState): number | undefined {
  if (s.when !== 'later' || !s.at?.local) return undefined;
  const iso = localToIso(s.at.local, s.at.zone);
  return iso ? Date.parse(iso) : undefined;
}

export function bodyOf(
  orgId: string,
  s: ComposerState,
  send: 'draft' | 'now' | 'schedule',
  at: number | undefined,
): NewBroadcast | undefined {
  const target = targetOf(s);
  if (!target) return undefined;
  const clearAfter = CLEAR_CHOICES.find((c) => c.value === s.clear)?.ms ?? null;
  const patch =
    s.kind === 'message'
      ? { message: s.clearing ? '' : s.message.trim() }
      : Object.fromEntries(
          s.fields.flatMap((key) => (s.values[key] === undefined ? [] : [[key, s.values[key]]])),
        );
  return {
    orgId,
    kind: s.kind,
    target,
    patch: patch as NewBroadcast['patch'],
    notify: s.notify,
    send,
    ...(send === 'schedule' && at !== undefined ? { at } : {}),
    ...(s.kind === 'message' && !s.clearing && clearAfter ? { clearAfter } : {}),
  };
}
