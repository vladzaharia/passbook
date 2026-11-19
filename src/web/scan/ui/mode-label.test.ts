import { describe, expect, it } from 'vitest';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { modeLabel } from './mode-label.ts';
import { dockStrip } from './strip-of.ts';

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

describe('dockStrip offline', () => {
  const queue = (pending: number) => ({
    online: false,
    queue: { pending, oldestAt: null, conflicts: 0 },
  });
  it('says scans are saved and how many wait', () => {
    expect(dockStrip(queue(3), undefined, false, 0)).toMatchObject({
      kind: 'system',
      title: 'Offline. Scans are saved and sync later.',
      meta: '3 saved',
    });
    expect(dockStrip(queue(0), undefined, false, 0)?.meta).toBe('');
  });
  it('is the last scan when online', () => {
    expect(dockStrip({ online: true, queue: queue(0).queue }, undefined, false, 0)).toBeNull();
  });
});
