import { describe, expect, it } from 'vitest';
import { sampleCsv } from './sample-csv.tsx';

describe('sampleCsv', () => {
  it('starts with Holder email, then the template fields, quoting what needs it', () => {
    expect(sampleCsv(['Name', 'Tier, level'])).toBe('Holder email,Name,"Tier, level"\n');
  });
});
