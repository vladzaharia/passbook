import { describe, expect, it } from 'vitest';
import { actionLabel } from '@/web/lib/actions.ts';
import {
  auditHref,
  auditSearchFor,
  dayToMs,
  msToDay,
  parseAuditSearch,
  rangeLabel,
} from './audit-search.ts';
import { actorRef, targetRef } from './labels.ts';
import { describeDetail, REDACTED, redact } from './redact.ts';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: 1_700_000_000_000 + id,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  action: `thing.updated.${id}`,
  actorLabel: null,
  targetType: 'org',
  targetId: 'o1',
  targetLabel: null,
  requestId: 'req-1',
  detail: null,
  ...over,
});

describe('redact', () => {
  it('hides values of secret-looking keys at any depth', () => {
    expect(
      redact({ name: 'a', apiKey: 'x', nested: { password: 'p', list: [{ token: 't', ok: 1 }] } }),
    ).toEqual({
      name: 'a',
      apiKey: REDACTED,
      nested: { password: REDACTED, list: [{ token: REDACTED, ok: 1 }] },
    });
  });
  it('keeps keys that only contain "key" as part of another word', () => {
    expect(redact({ keyboard: 'k', key: 's' })).toEqual({ keyboard: 'k', key: REDACTED });
  });
  it('describes before/after details as a diff and other details as JSON', () => {
    expect(describeDetail(null).kind).toBe('none');
    const diff = describeDetail({ before: { a: 1 }, after: { a: 2, secret: 'z' } });
    expect(diff.kind).toBe('diff');
    expect(diff.after).toContain(REDACTED);
    expect(diff.after).not.toContain('"z"');
    expect(describeDetail({ note: 'x' }).kind).toBe('json');
  });
});

describe('audit search', () => {
  it('parses numbers from strings and rejects junk', () => {
    expect(parseAuditSearch({ from: '100', to: 'abc', entry: 5, action: ' ' })).toMatchObject({
      from: 100,
      to: undefined,
      entry: 5,
      action: undefined,
    });
  });
  it('round-trips a day and makes the end of day inclusive', () => {
    const start = dayToMs('2026-03-04', false)!;
    expect(msToDay(start)).toBe('2026-03-04');
    expect(dayToMs('2026-03-04', true)! - start).toBe(86_400_000 - 1);
    expect(dayToMs('nope', false)).toBeUndefined();
  });
  it('builds pre-filtered links for entity pages', () => {
    expect(auditSearchFor({ target: 'pass', id: 'p1' })).toEqual({
      targetType: 'pass',
      targetId: 'p1',
    });
    expect(auditSearchFor({ actor: 'user', id: 'u1' })).toEqual({ actorId: 'u1' });
    expect(auditHref({ target: 'pass', id: 'p1' })).toBe(
      '/admin/audit?targetType=pass&targetId=p1',
    );
    expect(auditHref({ org: 'o1' })).toBe('/admin/audit?orgId=o1');
  });
  it('reads a date range as one value', () => {
    expect(rangeLabel(undefined, undefined)).toBe('any');
    expect(rangeLabel(dayToMs('2026-03-04', false), undefined)).toMatch(/^From Mar 4/);
  });
});

describe('labels', () => {
  it('maps action codes to sentences and humanizes unknown ones', () => {
    expect(actionLabel('auth.sign_in')).toBe('Signed in');
    expect(actionLabel('pass.resend_email')).toBe('Pass email resent');
    expect(actionLabel('thing.updated')).toBe('Thing updated');
  });
  it('prefers labels, falls back to a short id, and links targets', () => {
    const e = entry(1) as Parameters<typeof actorRef>[0];
    expect(actorRef(e)).toMatchObject({ kind: 'user', name: 'User u1', to: '/admin/users/u1' });
    expect(targetRef(e)).toMatchObject({ kind: 'org', name: 'Organization o1' });
    expect(actorRef({ ...e, actorLabel: 'Ada' }).name).toBe('Ada');
    expect(
      targetRef({ ...e, targetType: 'pass', targetId: 'p1', targetLabel: 'Clara' }),
    ).toMatchObject({
      name: 'Clara',
      to: '/admin/passes/p1',
    });
    expect(actorRef({ ...e, actorType: 'system', actorId: null }).name).toBe('System');
    expect(targetRef({ ...e, targetType: null, targetId: null })).toBeUndefined();
  });
});
