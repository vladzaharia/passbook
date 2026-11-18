import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { EMAIL_SUBJECT_MAX, emailManifestIssues, renderEmailSubject } from './email.ts';
import { validateManifest } from './manifest.ts';

const base = {
  schema: 1,
  name: 'T',
  inputs: { type: 'object', properties: { memberName: { type: 'string' } } },
  sample: { memberName: 'Alex' },
  bindings: [],
  display: { title: '{{memberName}}' },
} as unknown as TemplateManifest;
const withEmail = (email: unknown) => ({ ...base, email }) as TemplateManifest;
const codes = (m: TemplateManifest) => emailManifestIssues(m).map((i) => i.code);

describe('email.subject validation', () => {
  it('is optional and keeps schema 1', () => {
    expect(emailManifestIssues(base)).toEqual([]);
    expect(emailManifestIssues(withEmail({}))).toEqual([]);
    expect(
      validateManifest(withEmail({ subject: 'Hi {{memberName}}' })).map((i) => i.code),
    ).not.toContain('EMAIL_SUBJECT');
  });
  it.each([
    ['a line break', 'Hi\nthere'],
    ['a carriage return', 'Hi\rthere'],
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(EMAIL_SUBJECT_MAX + 1)],
    ['not a string', 5],
    ['an unknown input', 'Hi {{nobody}}'],
    ['an unknown lookup', 'Hi {{lookups.clubs[memberName].name}}'],
    ['a pass value', 'Code {{pass.scanCode}}'],
  ])('refuses %s', (_label, subject) => {
    expect(codes(withEmail({ subject }))).toEqual(['EMAIL_SUBJECT']);
  });
  it('accepts the longest subject', () => {
    expect(codes(withEmail({ subject: 'x'.repeat(EMAIL_SUBJECT_MAX) }))).toEqual([]);
  });
  it('refuses a non-object email block', () => {
    expect(codes(withEmail('hi'))).toEqual(['EMAIL_SUBJECT']);
  });
});

describe('renderEmailSubject', () => {
  const fallback = 'Your Org pass';
  it('renders placeholders from the pass input', () => {
    expect(
      renderEmailSubject(
        withEmail({ subject: 'Hi {{memberName}}' }),
        { memberName: 'Alex' },
        fallback,
      ),
    ).toBe('Hi Alex');
  });
  it('falls back without a subject or a manifest', () => {
    expect(renderEmailSubject(base, {}, fallback)).toBe(fallback);
    expect(renderEmailSubject(null, {}, fallback)).toBe(fallback);
  });
  it('falls back when it renders empty', () => {
    expect(renderEmailSubject(withEmail({ subject: '{{memberName}}' }), {}, fallback)).toBe(
      fallback,
    );
  });
  it('never carries a line break from the input', () => {
    const subject = renderEmailSubject(
      withEmail({ subject: 'Hi {{memberName}}' }),
      { memberName: 'A\r\nBcc: x@y.z' },
      fallback,
    );
    expect(subject).toBe('Hi A Bcc: x@y.z');
  });
  it('caps the length', () => {
    const subject = renderEmailSubject(
      withEmail({ subject: '{{memberName}}' }),
      { memberName: 'y'.repeat(500) },
      fallback,
    );
    expect(subject).toHaveLength(EMAIL_SUBJECT_MAX);
  });
});
