/** The scenarios of the tag gallery: assign states, door results and their readers. */
import type { TagReader } from './assign/tag-reader.ts';
import type { BindResult, ScanTag, TagEnrollment } from './assign/types.ts';
import { grant } from './machine/access-fixtures.test-support.ts';
import { type AssignState, TAG_OFFLINE } from './machine/assign-state.ts';
import { fixtureDisplay } from './machine/fixtures.test-support.ts';
import { fresh } from './machine/reduce-assign.ts';
import type { ScanOutcome } from './machine/types.ts';

export const NOW = 1_762_000_000_000;
const ENROLL: TagEnrollment = {
  id: '01900000-0000-7000-8000-0000000000bb',
  holderName: 'Maya Okafor',
  passTitle: 'HQ access',
  scope: 'user',
  requestedByName: 'Ana R.',
  expiresAt: Date.now() + 102_000,
};
const PREVIEW: BindResult = {
  status: 'preview',
  hint: '7F3A',
  assurance: 'basic',
  scope: 'pass',
  bindingId: null,
  card: {
    passId: '01900000-0000-7000-8000-0000000000aa',
    title: 'HQ access',
    subtitle: null,
    templateName: 'Staff · HQ access',
    holderName: 'Maya Okafor',
    photoUrl: null,
  },
  ownerAccount: true,
  skipped: [],
  warnings: [],
  lostAt: null,
  undoUntil: null,
};
const READ = {
  read: { uid: '04a2b37f3a', tech: 'a' as const, source: 'native' as const },
  sig: 't:x',
};
const base = (over: Partial<AssignState> = {}): AssignState => ({ ...fresh('menu', NOW), ...over });

export const ANDROID: TagReader = { kind: 'continuous', needsStart: false };
export const IPHONE: TagReader = { kind: 'sheet', needsStart: false };
export const WEB: TagReader = { kind: 'webnfc', needsStart: true };
export const USB: TagReader = { kind: 'wedge', needsStart: false };

export interface Assign {
  a: AssignState;
  reader: TagReader;
  knownName?: string | null;
  manager?: boolean;
}
export const assigns: Record<string, Assign> = {
  'assign-tag-android': { a: base(), reader: ANDROID },
  'assign-tag-iphone': { a: base(), reader: IPHONE },
  'assign-tag-web': { a: base(), reader: WEB },
  'assign-tag-usb': { a: base(), reader: USB },
  'assign-pass': {
    a: base({
      step: 'pass',
      tag: READ,
      inspected: {
        state: 'new',
        hint: '7F3A',
        assurance: 'basic',
        bound: null,
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
    }),
    reader: ANDROID,
  },
  'assign-pass-banner': {
    a: base({
      step: 'pass',
      banner: 'voided',
      tag: READ,
      inspected: {
        state: 'new',
        hint: '7F3A',
        assurance: 'basic',
        bound: null,
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
    }),
    reader: ANDROID,
  },
  'assign-confirm': {
    a: base({
      step: 'confirm',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      preview: { ...PREVIEW, warnings: [] },
    }),
    reader: ANDROID,
  },
  'assign-confirm-person': {
    a: base({
      step: 'confirm',
      scope: 'user',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      preview: { ...PREVIEW, warnings: ['replaces_pass_tag'] },
    }),
    reader: ANDROID,
  },
  'assign-confirm-other': {
    a: base({
      step: 'confirm',
      tag: READ,
      card: { code: 'C1', method: 'camera' },
      inspected: {
        state: 'bound',
        hint: '7F3A',
        assurance: 'basic',
        bound: { scope: 'pass', passTitle: 'Pool day', holderName: 'Leo Park' },
        lostAt: null,
        boundAt: null,
        boundByName: null,
      },
      preview: { ...PREVIEW, warnings: ['held_by_other'] },
    }),
    reader: ANDROID,
  },
  'assign-done': {
    a: base({
      step: 'done',
      label: 'Blue fob',
      result: { ...PREVIEW, status: 'bound', bindingId: 'b1', undoUntil: NOW + 600_000 },
    }),
    reader: ANDROID,
  },
  'assign-done-person': {
    a: base({
      step: 'done',
      result: {
        ...PREVIEW,
        status: 'bound',
        scope: 'user',
        bindingId: 'b1',
        undoUntil: NOW + 600_000,
      },
    }),
    reader: ANDROID,
  },
  'assign-lost': {
    a: base({ step: 'error', error: { kind: 'lost', at: NOW - 5 * 86_400_000 } }),
    reader: ANDROID,
  },
  'assign-secure': {
    a: base({ step: 'error', error: { kind: 'secure_needed' } }),
    reader: ANDROID,
  },
  'assign-already': {
    a: base({ step: 'error', error: { kind: 'already_here', at: NOW - 86_400_000, by: 'Sam K.' } }),
    reader: ANDROID,
  },
  'assign-unreadable-web': {
    a: base({ step: 'error', error: { kind: 'unreadable', web: true } }),
    reader: WEB,
  },
  'assign-offline': {
    a: base({ step: 'error', error: { kind: 'not_assigned' } }),
    reader: ANDROID,
  },
  'assign-too-many': {
    a: base({ step: 'error', error: { kind: 'too_many', seconds: 20 } }),
    reader: ANDROID,
  },
  'assign-holder-changed': {
    a: base({
      source: 'request',
      step: 'error',
      request: ENROLL,
      error: { kind: 'holder_changed' },
    }),
    reader: ANDROID,
  },
  'request-card': {
    a: base({ source: 'request', request: ENROLL, idleAt: ENROLL.expiresAt }),
    reader: ANDROID,
  },
  'request-card-iphone': {
    a: base({ source: 'request', request: { ...ENROLL, scope: 'pass' }, idleAt: ENROLL.expiresAt }),
    reader: IPHONE,
  },
  'request-done': {
    a: base({
      source: 'request',
      step: 'done',
      request: ENROLL,
      result: { ...PREVIEW, status: 'bound', scope: 'user', bindingId: 'b1' },
    }),
    reader: ANDROID,
  },
  'request-waiting': {
    a: base({ source: 'request', request: ENROLL, waiting: true }),
    reader: ANDROID,
  },
};

const tag = (over: Partial<ScanTag> = {}): ScanTag => ({
  hint: '7F3A',
  assurance: 'basic',
  scope: 'pass',
  ...over,
});
const manyPasses: ScanTag['passes'] = [
  { passId: '1', templateName: 'HQ access', state: 'used', reason: null },
  { passId: '2', templateName: 'Gym', state: 'lets_in', reason: null },
  { passId: '3', templateName: 'Parking', state: 'not_here', reason: null },
];
const nonePasses: ScanTag['passes'] = [
  { passId: '1', templateName: 'HQ access', state: 'refused', reason: 'outside_hours' },
  { passId: '2', templateName: 'Gym', state: 'refused', reason: 'expired' },
  { passId: '3', templateName: 'Parking', state: 'not_here', reason: null },
];
const display = fixtureDisplay('ok');
export const doors: Record<
  string,
  { outcome: ScanOutcome; tagRead: boolean; unknown?: boolean; add?: boolean }
> = {
  'door-tag-ok': { outcome: grant({ display, tag: tag() }), tagRead: true },
  'door-tag-of-many': {
    outcome: grant({ display, tag: tag({ scope: 'user', count: 3, passes: manyPasses }) }),
    tagRead: true,
  },
  'door-tag-none': {
    outcome: {
      ...grant({
        display: fixtureDisplay('refused'),
        tag: tag({ scope: 'user', count: 3, passes: nonePasses }),
      }),
      kind: 'refused',
      reason: 'outside_hours',
    } as ScanOutcome,
    tagRead: true,
  },
  'door-unknown': {
    outcome: {
      ...grant(),
      kind: 'refused',
      reason: 'not_found',
      display: null,
      card: null,
      access: null,
      occupancy: null,
    } as ScanOutcome,
    tagRead: true,
    unknown: true,
  },
  'door-channel-off': {
    outcome: {
      ...grant(),
      kind: 'refused',
      reason: 'channel_off',
      channel: 'apple',
      display: null,
      card: null,
      access: null,
      occupancy: null,
    } as ScanOutcome,
    tagRead: false,
  },
  'door-nfc-off': {
    outcome: {
      ...grant(),
      kind: 'refused',
      reason: 'channel_off',
      channel: 'nfc',
      display: null,
      card: null,
      access: null,
      occupancy: null,
    } as ScanOutcome,
    tagRead: true,
  },
  'door-typed-number': {
    outcome: {
      ...grant({ display: fixtureDisplay('heads_up') }),
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
      overridable: false,
    } as ScanOutcome,
    tagRead: false,
  },
  'door-add-tag': { outcome: grant({ display, tag: undefined }), tagRead: false, add: true },
  'door-offline': {
    outcome: {
      ...grant(),
      kind: 'system',
      reason: TAG_OFFLINE,
      display: null,
      card: null,
      access: null,
      occupancy: null,
      local: true,
    } as ScanOutcome,
    tagRead: true,
  },
};

export const TAG_SCENARIOS = [
  ...Object.keys(assigns),
  ...Object.keys(doors),
  'door-tap-to-read',
  'request-chip-waiting',
  'request-strip',
] as const;
export type TagScenario = (typeof TAG_SCENARIOS)[number];
