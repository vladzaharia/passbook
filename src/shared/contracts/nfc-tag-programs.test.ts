import { describe, expect, it } from 'vitest';
import { SCAN_TAG_PROGRAM_COPY } from '../copy/scan-tag-program.ts';
import {
  TAG_PROGRAM_ERROR_CODES,
  TagProgramAbortedSchema,
  TagProgramAbortSchema,
  TagProgramAuthSchema,
  TagProgramDoneSchema,
  type TagProgramErrorCode,
  TagProgramErrorCodeSchema,
  TagProgramProbeSchema,
  TagProgramReauthedSchema,
  TagProgramReauthSchema,
  TagProgramResultSchema,
  TagProgramSchema,
  type TagProgramStart,
  TagProgramStartedSchema,
  TagProgramStartSchema,
  type TagProgramState,
  TagProgramStateSchema,
  TagProgramStepSchema,
} from './nfc-tag-programs.ts';
import {
  TAG_PROGRAM_FEATURE,
  type TagProgramEvent,
  TagProgramEventSchema,
  type TagProgramOp,
  TagProgramOpSchema,
} from './tag-program-bridge.ts';

const hex = (bytes: number) => 'ab'.repeat(bytes);
const start: TagProgramStart = {
  uid: '04518dfaa96180',
  version: hex(28),
  sig: hex(56),
  auth1: hex(16),
  purpose: 'blank',
  idem: 'program-0001',
};

describe('tag program contracts', () => {
  it('start takes the three tag answers at their exact sizes and refuses the rest', () => {
    expect(TagProgramStartSchema.safeParse(start).success).toBe(true);
    expect(TagProgramStartSchema.safeParse({ ...start, sig: hex(55) }).success).toBe(false);
    expect(TagProgramStartSchema.safeParse({ ...start, auth1: 'zz'.repeat(16) }).success).toBe(
      false,
    );
    expect(TagProgramStartSchema.safeParse({ ...start, key: hex(16) }).success).toBe(false);
  });

  it('start answers with one APDU, auth with one response, the script with at most 32', () => {
    const now = 1_700_000_000_000;
    expect(
      TagProgramStartedSchema.safeParse({
        id: 'p1',
        resume: false,
        apdus: [hex(37)],
        expiresAt: now,
      }).success,
    ).toBe(true);
    expect(
      TagProgramStartedSchema.safeParse({ id: 'p1', resume: false, apdus: [], expiresAt: now })
        .success,
    ).toBe(false);
    expect(TagProgramAuthSchema.safeParse({ responses: [hex(34)] }).success).toBe(true);
    expect(TagProgramAuthSchema.safeParse({ responses: [] }).success).toBe(false);
    const script = { next: 'script', apdus: [hex(20)], stopOn: '9100' };
    expect(TagProgramStepSchema.safeParse(script).success).toBe(true);
    expect(
      TagProgramStepSchema.safeParse({ ...script, apdus: Array(33).fill(hex(2)) }).success,
    ).toBe(false);
    // A resumed row probes, a refused factory key re-authenticates; each answers on its own path.
    expect(
      TagProgramStepSchema.safeParse({ next: 'probe', apdus: [hex(14), hex(14)], stopOn: '9100' })
        .success,
    ).toBe(true);
    expect(TagProgramStepSchema.safeParse({ next: 'reauth', apdus: [hex(8)] }).success).toBe(true);
    expect(TagProgramStepSchema.safeParse({ next: 'reauth', apdus: [] }).success).toBe(false);
    expect(TagProgramProbeSchema.safeParse({ responses: [hex(10)] }).success).toBe(true);
    expect(TagProgramReauthSchema.safeParse({ responses: [hex(18), hex(18)] }).success).toBe(false);
    expect(TagProgramReauthedSchema.safeParse({ apdus: [hex(37)] }).success).toBe(true);
  });

  it('result carries every response, the read-back and an optional binding request', () => {
    const readback = {
      tech: 'isodep',
      source: 'native',
      ndef: { type: 'U', value: 'https://passbook.mobile/t/k?p=00&m=00' },
    };
    expect(TagProgramResultSchema.safeParse({ responses: [hex(10)], readback }).success).toBe(true);
    expect(
      TagProgramResultSchema.safeParse({
        responses: [hex(10)],
        readback,
        bind: { passId: 'x', scope: 'pass' },
        enrollmentId: 'e',
      }).success,
    ).toBe(true);
    expect(TagProgramResultSchema.safeParse({ responses: [], readback }).success).toBe(false);
    expect(
      TagProgramDoneSchema.safeParse({
        state: 'programmed',
        tag: { id: 't', hint: 'AB12' },
        binding: null,
        refusal: 'PASS_NOT_FOUND',
      }).success,
    ).toBe(true);
  });

  it('abort says why and the answer is always interrupted', () => {
    expect(TagProgramAbortSchema.safeParse({ responses: [], why: 'lost' }).success).toBe(true);
    expect(TagProgramAbortSchema.safeParse({ responses: [], why: 'bored' }).success).toBe(false);
    expect(TagProgramAbortedSchema.parse({ state: 'interrupted' }).state).toBe('interrupted');
  });

  it('the console row has the hint, never the UID', () => {
    const row = TagProgramSchema.parse({
      id: 'p',
      state: 'interrupted',
      purpose: 'blank',
      hint: 'AB12',
      scannerId: null,
      attempts: 1,
      errorCode: 'TAG_MOVED',
      createdAt: 1,
      updatedAt: 2,
      uid: 'x',
    });
    expect(Object.keys(row)).not.toContain('uid');
  });

  it('every state and error code parses, and every error code has scanner copy', () => {
    const states: TagProgramState[] = [
      'started',
      'scripted',
      'programmed',
      'interrupted',
      'failed',
      'reset',
      'abandoned',
    ];
    for (const s of states) expect(TagProgramStateSchema.parse(s)).toBe(s);
    for (const code of TAG_PROGRAM_ERROR_CODES) {
      const c: TagProgramErrorCode = TagProgramErrorCodeSchema.parse(code);
      expect(SCAN_TAG_PROGRAM_COPY.failed[c]).toMatch(/\.$/);
    }
    expect(Object.keys(SCAN_TAG_PROGRAM_COPY.failed).sort()).toEqual(
      [...TAG_PROGRAM_ERROR_CODES].sort(),
    );
  });
});

describe('tagProgram bridge shapes', () => {
  it('names the feature and shapes the three ops and three events', () => {
    expect(TAG_PROGRAM_FEATURE).toBe('tagProgram');
    const ops: TagProgramOp[] = [
      { op: 'tagSession', id: 'tp-1', prompt: 'Hold a blank tag.', timeoutMs: 60_000 },
      { op: 'apdu', id: 'a-1', session: 's-1', apdus: ['00a4040c07d2760000850101'] },
      { op: 'tagSessionEnd', session: 's-1', message: 'Tag ready.' },
    ];
    for (const op of ops) expect(TagProgramOpSchema.parse(op)).toEqual(op);
    expect(
      TagProgramOpSchema.safeParse({ op: 'apdu', id: 'a', session: 's', apdus: [] }).success,
    ).toBe(false);
    const events: TagProgramEvent[] = [
      { event: 'tagSession', id: 'tp-1', session: 's-1', uid: '04518dfaa96180' },
      { event: 'apdu', id: 'a-1', session: 's-1', responses: ['9000'], refused: 'APDU_REFUSED' },
      { event: 'tagLost', session: 's-1' },
    ];
    for (const event of events) expect(TagProgramEventSchema.parse(event)).toEqual(event);
  });
});
