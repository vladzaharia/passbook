import type { ScanState } from './types.ts';

export function initialState(now: number): ScanState {
  return {
    loop: { s: 'ready', since: now, hint: 0 },
    started: false,
    camera: 'off',
    overlay: null,
    block: null,
    posture: 'door',
    layout: 'handheld',
    armed: null,
    scope: { key: null, direction: 'in', operator: null },
    card: null,
    focused: true,
    online: navigator.onLine,
    unsure: [],
    queue: { pending: 0, oldestAt: null, conflicts: 0 },
    reader: { kind: 'none', lastAt: null, badLayout: 0 },
    undo: null,
    ignore: [],
    recent: [],
    counts: null,
    prefs: { holdResults: false, sound: true },
    lastActivity: now,
  };
}
