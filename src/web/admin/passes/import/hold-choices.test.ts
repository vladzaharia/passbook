import { describe, expect, it } from 'vitest';
import {
  PASS_IMPORT_HOLD_MAX_MS,
  PassImportEmailSendSchema,
} from '@/shared/contracts/pass-imports.ts';
import { HOLD_CHOICES } from './api-run.ts';

describe('email hold choices', () => {
  it('offers Now and five holds, keeping the first three', () => {
    expect(HOLD_CHOICES.map((h) => h.value)).toEqual(['now', '5m', '15m', '1h', '4h', '24h']);
  });

  it('are all accepted by the API contract', () => {
    for (const h of HOLD_CHOICES.filter((c) => c.holdMs > 0))
      expect(PassImportEmailSendSchema.safeParse({ send: 'held', holdMs: h.holdMs }).success).toBe(
        true,
      );
    expect(Math.max(...HOLD_CHOICES.map((h) => h.holdMs))).toBe(PASS_IMPORT_HOLD_MAX_MS);
  });
});
