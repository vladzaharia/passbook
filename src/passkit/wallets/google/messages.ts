/**
 * Google change messages (design-google-messages 4): the one message an update sends, derived from
 * the stored pass versions, and the `messages` array PassBook writes on every object upsert.
 */
import type { PassJson } from '../../types.ts';
import { sanitizeText, shorten } from '../text.ts';
import type { ViewField } from '../types.ts';
import { buildFields, styleOf } from '../view-fields.ts';
import { bodyOf } from './fields.ts';
import { TEXT } from './limits.ts';
import { voidedMessage } from './parts.ts';
import type { GoogleMessage, GoogleObjectCommon } from './types.ts';

/** Google keeps at most 10 messages per object; the tenth slot is the next `addMessage`. */
export const MAX_HISTORY = 9;
export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeliveredMessage {
  id: string;
  header: string;
  body: string;
  settledAt: number;
}

const fieldsOf = (pass: PassJson): ViewField[] => buildFields(pass, styleOf(pass));
const same = (a: ViewField, b: ViewField): boolean =>
  JSON.stringify(a.value) === JSON.stringify(b.value);

/** `%@` becomes the value and `%%` a percent sign, in one left-to-right pass. */
const fill = (template: string, value: string): string =>
  template.replace(/%([@%])/gu, (_m, c: string) => (c === '@' ? value : '%'));

/**
 * `versions[0]` is the base; the rest follow in order up to the target. Null when nothing notifies.
 */
export function googleChangeMessage(
  versions: readonly PassJson[],
): { header: string; body: string } | null {
  const target = versions[versions.length - 1];
  if (versions.length < 2 || !target) return null;
  const all = versions.map(fieldsOf);
  const last = all[all.length - 1] ?? [];
  // Per key, the latest version where it notified.
  const notified = new Map<string, ViewField>();
  for (let i = 1; i < all.length; i++) {
    const before = new Map((all[i - 1] ?? []).map((f) => [f.key, f]));
    for (const f of all[i] ?? []) {
      const prev = before.get(f.key);
      if (!prev || same(prev, f)) continue;
      if (typeof f.changeMessage === 'string') notified.set(f.key, f);
      else notified.delete(f.key);
    }
  }
  const texts: string[] = [];
  for (const f of last) {
    const hit = notified.get(f.key);
    if (!hit || !same(hit, f)) continue;
    const text = sanitizeText(fill(hit.changeMessage ?? '', bodyOf(hit)));
    if (text) texts.push(text);
  }
  if (texts.length === 0) return null;
  const org = typeof target.organizationName === 'string' ? target.organizationName : '';
  return {
    header: shorten(sanitizeText(org), TEXT.title).text,
    body: shorten(texts.join('\n'), TEXT.body).text,
  };
}

/** The object's `messages`: delivered history as TEXT (newest 9 of the last 30 days, oldest first), or the voided message only. */
export function withMessageHistory<T extends GoogleObjectCommon>(
  objectBody: T,
  history: readonly DeliveredMessage[],
  voided: boolean,
  now: number,
): T {
  if (voided) return { ...objectBody, messages: [voidedMessage] };
  const messages: GoogleMessage[] = history
    .filter((m) => m.settledAt > now - HISTORY_WINDOW_MS)
    .sort((a, b) => b.settledAt - a.settledAt)
    .slice(0, MAX_HISTORY)
    .reverse()
    .map((m) => ({ id: m.id, header: m.header, body: m.body, messageType: 'TEXT' }));
  return { ...objectBody, messages };
}
