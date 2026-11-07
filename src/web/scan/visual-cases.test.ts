import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../shared/contracts/scan-display.ts';
import { SCAN_VISUAL_CASES } from './visual-cases.test-support.ts';

describe('scan visual scenarios', () => {
  it.each(SCAN_VISUAL_CASES)('$name uses a valid rendered display contract', ({ outcome }) => {
    expect(ScanDisplaySchema.safeParse(outcome.display).success).toBe(true);
  });
});
