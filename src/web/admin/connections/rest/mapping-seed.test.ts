import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type SampleField, seedFromSample } from './mapping-seed.ts';

const monthly = JSON.parse(
  readFileSync('templates/starter-monthly-pass/wallet.template.json', 'utf8'),
) as { inputs: unknown };

const field = (pointer: string, label: string, samples: string[]): SampleField => ({
  pointer,
  label,
  samples,
  preview: samples[0] ?? '',
});

describe('mapping rows from a REST sample', () => {
  const fields = [
    field('/member_id', 'member_id', ['m_1', 'm_2', 'm_3']),
    field('/email', 'email', ['a@x.com', 'b@x.com', 'c@x.com']),
    field('/name', 'name', ['Alex Morgan', 'Sam Lee', 'Jo Park']),
    field('/status', 'status', ['Active', 'Suspended', 'Active']),
  ];

  it('matches template fields by name and by value, with the record pointers a sync reads', () => {
    const seed = seedFromSample(monthly.inputs, fields);
    const by = Object.fromEntries(seed.rows.map((r) => [r.input, r.from]));
    expect(by.memberName).toBe('/name');
    expect(by.memberId).toBe('/member_id');
    expect(by.status).toBe('/status');
    expect(seed.holderEmailField).toBe('/email');
  });

  it('maps a nested field back to its own pointer, not the label one', () => {
    const seed = seedFromSample(monthly.inputs, [
      field('/profile/name', 'profile/name', ['Alex Morgan', 'Sam Lee']),
      field('/profile/ref', 'profile/ref', ['m_1', 'm_2']),
    ]);
    const from = seed.rows.map((r) => r.from);
    expect(from.every((p) => p.startsWith('/profile/') && !p.includes('~1'))).toBe(true);
  });

  it('leaves the rows empty when nothing fits', () => {
    const seed = seedFromSample(monthly.inputs, [field('/zz', 'zz', ['', '', ''])]);
    expect(seed.rows).toEqual([]);
    expect(seed.holderEmailField).toBe('');
  });
});
