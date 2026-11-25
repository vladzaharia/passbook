import { describe, expect, it } from 'vitest';
import { DATA_CLASSES, RETENTION_CLASSES } from './data-classes.ts';
import { buildSummary, renderSummaryMarkdown, type SummaryInput } from './summary.ts';

const org = { id: 'o1', name: 'Acme | Gym' };
const none = { legalName: null, email: null, url: null };
const defaults = (): SummaryInput['effective'] =>
  Object.fromEntries(
    RETENTION_CLASSES.map((c) => [
      c,
      { days: DATA_CLASSES[c].platformDefault, source: 'platform' as const },
    ]),
  );
const md = (over: Partial<SummaryInput> = {}) =>
  renderSummaryMarkdown(
    buildSummary({
      org,
      contacts: none,
      effective: defaults(),
      holds: 0,
      lastReceipts: [],
      ...over,
    }),
  );

describe('privacy summary', () => {
  it('defaults only', () => {
    const text = md();
    expect(text).toContain('# Data processing summary: Acme | Gym');
    expect(text).toContain(
      '| Scans: Time, place, result and staff of each scan, and staff notes on a pass | 396 days | Deleted | platform |',
    );
    expect(text).toContain(
      '| Visitor passes: Passes on a guest plan, after the visit ends | 90 days | Pass deleted | platform |',
    );
    expect(text).toContain('- Audit log: 365 days or more');
    expect(text).toContain('Legal holds in force: 0');
    expect(text).not.toContain('Last deletion runs');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('every class overridden by the org', () => {
    const effective = Object.fromEntries(
      RETENTION_CLASSES.map((c) => [c, { days: DATA_CLASSES[c].floor, source: 'org' as const }]),
    );
    const text = md({
      effective,
      contacts: {
        legalName: 'Acme Ltd',
        email: 'p@acme.example',
        url: 'https://acme.example/privacy',
      },
    });
    for (const c of RETENTION_CLASSES) expect(text).toContain(`| ${DATA_CLASSES[c].floor} days |`);
    expect(text.match(/\| org \|/g)).toHaveLength(RETENTION_CLASSES.length);
    expect(text).toContain('- Legal name: Acme Ltd');
    expect(text).toContain('- Privacy contact: p@acme.example');
    expect(text).toContain('- Privacy notice: https://acme.example/privacy');
  });

  it('a pending shorter value shows its start date', () => {
    const effective = {
      ...defaults(),
      scans: { days: 800, source: 'org' as const, pendingShorterFrom: Date.UTC(2026, 10, 25) },
    };
    expect(md({ effective })).toContain('800 days (shorter from 2026-11-25)');
  });

  it('a held org counts holds and discloses nothing else', () => {
    const text = md({ holds: 2 });
    expect(text).toContain('Legal holds in force: 2');
    expect(text.toLowerCase()).not.toContain('reason');
  });

  it('a skipped class is left out, and receipts are listed', () => {
    const effective = defaults();
    delete effective.photos;
    const text = md({
      effective,
      lastReceipts: [{ cls: 'scans', ranAt: Date.UTC(2026, 10, 1), deleted: 12 }],
    });
    expect(text).not.toContain('Photos of voided');
    expect(text).toContain('- scans: 2026-11-01, 12 removed');
  });

  it('is deterministic', () => {
    expect(md()).toBe(md());
  });
});
