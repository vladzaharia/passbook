import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_ICONS, ROW_ICONS } from '../src/generated/plan-icons.ts';

const emailDir = (kind: string) => resolve(import.meta.dirname, '../public/email', kind);
const expected = (ids: string[]) => ids.flatMap((id) => [`${id}-2x.png`, `${id}-3x.png`]).sort();

describe('email icon PNGs', () => {
  it('match the plan icons', () => {
    expect(readdirSync(emailDir('plans')).sort()).toEqual(expected(Object.keys(PLAN_ICONS)));
  });

  it('match the row icons', () => {
    expect(readdirSync(emailDir('rows')).sort()).toEqual(expected(Object.keys(ROW_ICONS)));
  });
});
