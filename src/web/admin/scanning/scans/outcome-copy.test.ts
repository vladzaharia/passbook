import { describe, expect, it } from 'vitest';
import { actionText, methodLabel, scanStatusKey, whereText, whoText } from './outcome-copy.ts';

const scanner = {
  scannerName: 'Tablet',
  scannerId: 's1',
  actor: { type: 'scanner', id: 's1' },
} as const;
const admin = { scannerName: null, scannerId: null, actor: { type: 'user', id: 'u1' } } as const;

describe('scan activity wording', () => {
  it('maps outcomes to the shared status keys', () => {
    expect(scanStatusKey('ok')).toBe('scan_done');
    expect(scanStatusKey('heads_up')).toBe('scan_heads_up');
    expect(scanStatusKey('refused')).toBe('scan_refused');
    expect(scanStatusKey('ok', 5)).toBe('scan_undone');
  });
  it('writes reasons and methods in plain words', () => {
    expect(actionText({ actionLabel: null, reason: 'not_found' })).toBe('Not found');
    expect(actionText({ actionLabel: 'Check in', reason: null })).toBe('Check in');
    expect(methodLabel('wedge')).toBe('Scanner gun');
  });
  it('attributes to the scanner and staff, falling back honestly', () => {
    expect(whereText({ ...scanner })).toBe('Tablet');
    expect(whereText({ ...scanner, scannerName: null })).toBe('Scanner');
    expect(whereText(admin)).toBe('Admin scan');
    expect(whoText({ ...scanner, staffName: 'Mara' })).toBe('Mara');
    expect(whoText({ ...scanner, staffName: null })).toBe('Not signed in');
    expect(whoText({ ...admin, staffName: null })).toBe('Admin');
  });
});
