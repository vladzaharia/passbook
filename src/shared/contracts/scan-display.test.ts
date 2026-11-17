import { describe, expect, it } from 'vitest';
import { ScanOutcomeSchema } from './scan.ts';
import { ScanDisplayReadSchema, ScanDisplaySchema } from './scan-display.ts';

const display = (headerIcon: unknown) => ({
  v: 1,
  screen: 'ok',
  templateVersion: 'v1',
  variant: null,
  identity: { holder: 'Alex', initials: 'A', photo: null },
  header: { icon: headerIcon, title: 'Ticket', titleLines: 1, meta: null, chips: [] },
  panels: [],
  notes: { staff: null, refused: null },
});

describe('scan icons in a rendered outcome', () => {
  it('a client reads an icon id its build does not know as info instead of failing', () => {
    expect(ScanDisplayReadSchema.parse(display('hovercraft')).header.icon).toBe('info');
    expect(ScanOutcomeSchema.shape.display.parse(display('hovercraft'))?.header.icon).toBe('info');
  });

  it('keeps a known icon, and null', () => {
    expect(ScanDisplayReadSchema.parse(display('plane')).header.icon).toBe('plane');
    expect(ScanDisplayReadSchema.parse(display(null)).header.icon).toBeNull();
  });

  it('the strict schema still refuses an unknown icon', () => {
    expect(ScanDisplaySchema.safeParse(display('hovercraft')).success).toBe(false);
    expect(ScanDisplaySchema.safeParse(display('plane')).success).toBe(true);
  });
});
