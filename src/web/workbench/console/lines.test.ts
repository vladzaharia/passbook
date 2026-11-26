import { describe, expect, it } from 'vitest';
import { linesFor } from './lines.ts';
import { initialDraft } from './request.ts';
import { passesCreate, passesVoid } from './test-support.ts';

const TOKEN = 'pbtry_SECRET.SIG';

describe('the request as code', () => {
  it('writes curl, the three SDKs and no CLI where the CLI has no command', () => {
    const lines = linesFor(passesVoid, initialDraft(passesVoid), 'https://passbook.mobile');
    expect(lines.map((l) => l.lang)).toEqual(['curl', 'ts', 'py', 'go']);
  });

  it('writes the CLI line for the operations it has a command for, with the form’s own values', () => {
    const draft = initialDraft(passesCreate);
    const lines = linesFor(passesCreate, draft, 'https://passbook.mobile');
    expect(lines.map((l) => l.lang)).toEqual(['curl', 'ts', 'py', 'go', 'cli']);
    expect(lines.find((l) => l.lang === 'cli')?.code).toContain('passbook passes create');
    expect(lines.find((l) => l.lang === 'curl')?.code).toContain('"templateId"');
  });

  it('follows what the form holds: path ids, the body and the key off', () => {
    const draft = {
      ...initialDraft(passesVoid),
      path: { id: 'pass_77' },
      idemOn: false,
    };
    const lines = linesFor(passesVoid, draft, 'https://passbook.mobile');
    for (const l of lines) expect(l.code, l.lang).toContain('pass_77');
    expect(lines[0]?.code).toContain('https://passbook.mobile/api/v1/passes/pass_77/void');
  });

  it('puts the key in $PASSBOOK_KEY in every line and never a token', () => {
    const draft = {
      ...initialDraft(passesCreate),
      header: { Authorization: `Bearer ${TOKEN}` },
    };
    for (const l of linesFor(passesCreate, draft, 'https://passbook.mobile')) {
      expect(l.code, l.lang).not.toContain(TOKEN);
      if (l.lang !== 'cli') expect(l.code, l.lang).toContain('PASSBOOK_KEY');
    }
  });
});
