import { describe, expect, it } from 'vitest';
import { sampleCsv } from './sample-csv.tsx';

describe('sampleCsv', () => {
  it('starts with Holder email, then the template fields, quoting what needs it', () => {
    expect(sampleCsv(['Name', 'Tier, level'])).toBe('Holder email,Name,"Tier, level"');
  });

  it('guards a heading that a spreadsheet would run as a formula', () => {
    expect(sampleCsv(['=SUM(A1)', '-x'])).toBe("Holder email,'=SUM(A1),'-x");
  });
});
