import { expect, it } from 'vitest';
import { PASS_IMPORT_HOLD_MAX_MS } from '../../../shared/contracts/pass-imports.ts';
import { UNDO_WINDOW_MS } from './import-undo.ts';

it('a held email goes out no later than the undo window closes', () => {
  expect(PASS_IMPORT_HOLD_MAX_MS).toBeLessThanOrEqual(UNDO_WINDOW_MS);
});
