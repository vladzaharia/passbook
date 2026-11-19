import { describe, expect, it } from 'vitest';
import { issueWords } from './issues.ts';

describe('issueWords', () => {
  it('says a shadowed input in plain words', () => {
    expect(
      issueWords({
        code: 'SCAN_DISPLAY_SHADOWED',
        message: 'Input "access" is hidden by a display root. Use inputs.access.',
      }),
    ).toBe(
      'The scan screen shows the built-in "access", not your input. Use inputs.access for the input.',
    );
  });
  it('words a cut screen and a dead variant', () => {
    expect(
      issueWords({ code: 'SCAN_DISPLAY_CUT', message: 'Rows are cut on the not ok screen.' }),
    ).toBe('Some rows do not fit on the not ok screen and are cut.');
    expect(
      issueWords({ code: 'SCAN_DISPLAY_VARIANT_UNREACHABLE', message: '"VIP" never applies.' }),
    ).toBe('"VIP" never shows. An earlier variant always matches first.');
  });
  it('leaves other issues alone', () => {
    expect(issueWords({ code: 'OTHER', message: 'As is.' })).toBe('As is.');
  });
});
