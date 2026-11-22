/** Tag gallery scenarios: the done card with a photo, the PIN at the pass step, the person scope refused. */
import { ANDROID, type Assign, base, NOW, PHOTO, PREVIEW, READ } from './visual-tags-shared.ts';

export const moreAssigns: Record<string, Assign> = {
  'assign-done-photo': {
    a: base({
      step: 'done',
      tag: READ,
      result: {
        ...PREVIEW,
        status: 'bound',
        bindingId: 'b1',
        undoUntil: NOW + 600_000,
        card: { ...PREVIEW.card, photoUrl: PHOTO },
      },
    }),
    reader: ANDROID,
  },
  'assign-pass-pin': {
    a: base({
      step: 'pass',
      tag: READ,
      card: { passId: '01900000-0000-7000-8000-0000000000aa', method: 'manual' },
      pin: { open: true, move: false },
    }),
    reader: ANDROID,
  },
  'assign-confirm-person-off': {
    a: base({
      step: 'confirm',
      scope: 'pass',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      note: { kind: 'person_off', until: NOW + 120_000 },
      preview: { ...PREVIEW, opensDefault: 'user' },
    }),
    reader: ANDROID,
  },
  'assign-confirm-lost-pin': {
    a: base({
      step: 'confirm',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      preview: { ...PREVIEW, warnings: ['lost'], lostAt: NOW - 86_400_000 },
      pin: { open: true, move: true },
    }),
    reader: ANDROID,
  },
  'assign-pass-pin-wrong': {
    a: base({
      step: 'pass',
      tag: READ,
      card: { passId: '01900000-0000-7000-8000-0000000000aa', method: 'manual' },
      pin: { open: true, move: false, note: { triesLeft: 2 } },
    }),
    reader: ANDROID,
  },
};
