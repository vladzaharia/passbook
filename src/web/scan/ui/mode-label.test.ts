import { describe, expect, it } from 'vitest';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { modeLabel } from './mode-label.ts';

const session = (surface?: string, role?: string) =>
  ({
    workspace: surface ? { device: { effectiveSurface: surface } } : null,
    staff: role ? { role } : null,
  }) as unknown as ScanSession;

describe('modeLabel', () => {
  it('names the operator surface, then the staff role, then Door', () => {
    expect(modeLabel(session('operator', 'door'))).toBe('Operator');
    expect(modeLabel(session('phone', 'manager'))).toBe('Manager');
    expect(modeLabel(session('phone', 'desk'))).toBe('Desk');
    expect(modeLabel(session('phone'))).toBe('Door');
    expect(modeLabel(session())).toBe('Door');
  });
});
