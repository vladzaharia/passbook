import { describe, expect, it } from 'vitest';
import { resolvePaper } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { PaperTicket } from './paper.ts';
import { paperHash } from './paper-hash.ts';

const ticket = (over: Partial<PaperContent> = {}): PaperTicket => ({
  design: resolvePaper(undefined),
  content: {
    brand: 'Northwind',
    kind: 'admission',
    ink: 'color',
    colors: { bg: '#112233', fg: '#ffffff', label: '#cccccc' },
    logo: true,
    title: 'Spring Gala',
    kicker: 'Event ticket',
    noun: 'Ticket',
    start: '2026-12-01T19:00:00Z',
    zone: 'UTC',
    venue: 'Hall',
    holder: 'Ada Lovelace',
    facts: [{ label: 'Seat', text: '12' }],
    bring: ['This page'],
    help: ['Ask at the door'],
    extras: [],
    ...over,
  } as PaperContent,
  files: { logo: 'logo.png' },
});

describe('paperHash', () => {
  it('is 64 hex and stable', async () => {
    expect(await paperHash(ticket())).toMatch(/^[0-9a-f]{64}$/);
    expect(await paperHash(ticket())).toBe(await paperHash(ticket()));
  });

  it('ignores copy, kind, ink, colours and size: a paper deploy never stales a print', async () => {
    const base = await paperHash(ticket());
    const other = ticket({
      kind: 'membership',
      ink: 'mono',
      kicker: 'Entry pass',
      noun: 'Pass',
      bring: ['Something else'],
      colors: { bg: '#000000', fg: '#ffffff', label: '#999999' },
    });
    other.design = { ...other.design, size: 'cr80' };
    expect(await paperHash(other)).toBe(base);
  });

  it('follows the pass: the holder, the time and a fact change it', async () => {
    const base = await paperHash(ticket());
    expect(await paperHash(ticket({ holder: 'Grace Hopper' }))).not.toBe(base);
    expect(await paperHash(ticket({ start: '2026-12-02T19:00:00Z' }))).not.toBe(base);
    expect(await paperHash(ticket({ facts: [{ label: 'Seat', text: '13' }] }))).not.toBe(base);
    expect(await paperHash(ticket({ help: ['Call 555-0100'] }))).not.toBe(base);
  });

  it('ignores a fact label, which is copy', async () => {
    const base = await paperHash(ticket());
    expect(await paperHash(ticket({ facts: [{ label: 'Place', text: '12' }] }))).toBe(base);
  });
});
