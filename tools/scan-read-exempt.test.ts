import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'src/worker/modules/scan/';

describe('scanRead exemption', () => {
  it('no scan file skips the join-once check', () => {
    const users = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /differential-legacy|legacyRead|exempt\?:/.test(readFileSync(dir + f, 'utf8')),
      );
    expect(users).toEqual([]);
  });
});
