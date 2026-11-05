import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { applyChangeMessages, notifiesHolder } from './change-messages.ts';

const pass = (fields: Record<string, unknown>[]): PassJson =>
  ({ generic: { primaryFields: [], backFields: fields } }) as unknown as PassJson;
const field = (extra: Record<string, unknown> = {}) => ({
  key: 'tier',
  label: 'Tier',
  value: 'Silver',
  ...extra,
});
const messageOf = (p: PassJson) =>
  (p as unknown as { generic: { backFields: { changeMessage?: string }[] } }).generic.backFields[0]
    ?.changeMessage;

describe('applyChangeMessages', () => {
  it('names the field when the template gives no message', () => {
    const next = pass([field({ value: 'Gold' })]);
    expect(applyChangeMessages(next, pass([field()]), true)).toBe(true);
    expect(messageOf(next)).toBe('Tier is now %@');
  });

  it('keeps a message the template wrote and escapes a percent in the label', () => {
    const own = pass([field({ value: 'Gold', changeMessage: 'Upgraded to %@' })]);
    applyChangeMessages(own, pass([field()]), true);
    expect(messageOf(own)).toBe('Upgraded to %@');
    const pct = pass([field({ label: '100% Club', value: 'Gold' })]);
    applyChangeMessages(pct, pass([field()]), true);
    expect(messageOf(pct)).toBe('100%% Club is now %@');
  });

  it('does not message a field the previous version lacked', () => {
    const next = pass([
      field({ key: 'message', label: 'Message', value: 'Hi', changeMessage: '%@' }),
    ]);
    expect(applyChangeMessages(next, pass([]), true)).toBe(true);
    expect(messageOf(next)).toBeUndefined();
  });

  it('strips every message when not notifying', () => {
    const next = pass([field({ value: 'Gold' })]);
    applyChangeMessages(next, pass([field()]), false);
    expect(messageOf(next)).toBeUndefined();
  });
});

describe('notifiesHolder', () => {
  it('counts only fields the previous version had', () => {
    const added = pass([field({ key: 'message', value: 'Hi', changeMessage: '%@' })]);
    expect(notifiesHolder(added, pass([]))).toBe(false);
    const changed = pass([field({ value: 'Gold', changeMessage: 'x %@' })]);
    expect(notifiesHolder(changed, pass([field()]))).toBe(true);
    expect(notifiesHolder(changed, null)).toBe(false);
  });
});
