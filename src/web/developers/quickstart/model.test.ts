import { describe, expect, it } from 'vitest';
import { EXAMPLE_IDS } from '../model/ids.ts';
import {
  createCode,
  firstInput,
  fixFor,
  fixOfCall,
  litLines,
  maskKey,
  patchCode,
  stamp,
} from './model.ts';

const SAMPLE = {
  eventName: 'Sample Event',
  venueName: 'Sample Hall',
  venueRegion: 'Cupertino, CA',
  startsAt: '2030-06-01T19:00:00-07:00',
  endsAt: '2030-06-01T22:00:00-07:00',
  attendee: 'Alex Morgan',
  ticketId: 'TICKET-0001',
  upcomingEvents: [{ name: 'Encore' }],
  doorsAt: '2030-06-01T18:00:00-07:00',
};
const BASE = 'https://passbook.test/api/v1';

describe('the first request', () => {
  it('is the template’s required fields with a name of your own, and nothing else', () => {
    const input = firstInput(SAMPLE);
    expect(Object.keys(input).sort()).toEqual(
      [
        'attendee',
        'endsAt',
        'eventName',
        'startsAt',
        'ticketId',
        'venueName',
        'venueRegion',
      ].sort(),
    );
    expect(input.attendee).toBe('Casey River');
  });

  it('is written for the sandbox’s template in four languages, with no key in it', () => {
    const codes = createCode('tpl-1', firstInput(SAMPLE), BASE);
    expect(codes.map((c) => c.lang)).toEqual(['ts', 'curl', 'py', 'go']);
    for (const c of codes) {
      expect(c.code).toContain('tpl-1');
      expect(c.code).toContain('PASSBOOK_KEY');
      expect(c.code).not.toMatch(/\bpb[pt]?_(test|live)_/);
    }
  });

  it('keys the curl sample with date, not uuidgen', () => {
    const curl = createCode('tpl-1', firstInput(SAMPLE), BASE).find((c) => c.lang === 'curl');
    expect(curl?.code).toContain('Idempotency-Key: qs-$(date +%s)');
    expect(curl?.code).not.toContain('uuidgen');
  });

  it('changes the pass it was given, with the version it read', () => {
    const codes = patchCode('pass-9', 3, 'VIP', BASE);
    for (const c of codes) {
      expect(c.code).toContain('pass-9');
      expect(c.code).not.toContain(EXAMPLE_IDS.passId);
      expect(c.code).toContain('VIP');
    }
    expect(codes.find((c) => c.lang === 'curl')?.code).toContain('If-Match: "3"');
  });
});

describe('what the page says of a failure', () => {
  it('names the missing release and offers to finish the setup', () => {
    const fix = fixFor({ status: 409, code: 'TEMPLATE_RELEASE_REQUIRED', detail: 'long' }, true);
    expect(fix).toMatchObject({ repair: true, code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(fix.title).toBe('The template has no test release.');
  });

  it('offers the repair when the sandbox has no template at all', () => {
    expect(fixFor({ status: 0, code: undefined, detail: '' }, false).repair).toBe(true);
  });

  it('uses the API’s own sentence for any other problem, and links its code', () => {
    const fix = fixFor({ status: 422, code: 'VALIDATION_FAILED', detail: 'Fix the input.' }, true);
    expect(fix).toEqual({
      title: 'Fix the input.',
      line: '',
      repair: false,
      code: 'VALIDATION_FAILED',
    });
  });

  it('says a lost connection is that, with no code to look up', () => {
    const fix = fixFor({ status: 0, code: undefined, detail: '' }, true);
    expect(fix.code).toBeUndefined();
    expect(fix.repair).toBe(false);
  });

  it('stamps a status in words', () => {
    expect(stamp(201)).toBe('201 CREATED');
    expect(stamp(409)).toBe('409 CONFLICT');
    expect(stamp(0)).toBe('NO ANSWER');
    expect(stamp(503)).toBe('503 ERROR');
  });
});

describe('small helpers', () => {
  it('draws a key as its start and last four, never the middle', () => {
    expect(maskKey('pbp_test_abcdefghijklmnop1f3a')).toBe('pbp_test_…1f3a');
  });
  it('lights the lines that name the input', () => {
    expect([...litLines('a\ninput: {\nb\nattendee: 1', ['input', 'attendee'])]).toEqual([2, 4]);
  });
});

describe('fixOfCall', () => {
  const sample = { eventName: 'Sample Event', ticketId: 'QS-1042' };
  const response = JSON.stringify({
    status: 422,
    title: 'Validation failed',
    detail: 'The pass input is invalid.',
    code: 'PASS_INPUT_INVALID',
    issues: [{ path: '', message: '[redacted]' }],
  });
  const sentWithout = (field: string) =>
    JSON.stringify({
      templateId: 'x',
      input: Object.fromEntries(
        Object.keys(sample)
          .filter((k) => k !== field)
          .map((k) => [k, '[redacted]']),
      ),
    });

  it('finds the field the body lacks, from the log that keeps names and blanks values', () => {
    const fix = fixOfCall(
      { status: 422, code: 'PASS_INPUT_INVALID' },
      { response, request: sentWithout('ticketId') },
      sample,
    );
    expect(fix).toMatchObject({
      title: 'ticketId is required.',
      path: 'input.ticketId',
      line: 'Add "ticketId": "QS-1042" to input and run again.',
      code: 'PASS_INPUT_INVALID',
    });
  });

  it('uses a path the problem names, and survives a missing or hostile body', () => {
    const named = JSON.stringify({ issues: [{ path: 'templateId' }] });
    expect(
      fixOfCall({ status: 400, code: null }, { response: named, request: null }, sample).line,
    ).toBe('Check templateId, then run again.');
    expect(
      fixOfCall({ status: 500, code: null }, { response: null, request: null }, sample),
    ).toMatchObject({
      title: 'The request failed.',
      line: '',
      path: null,
      code: undefined,
    });
    expect(
      fixOfCall(
        { status: 422, code: null },
        { response: '[redacted]', request: '[json, not parseable]' },
        null,
      ).line,
    ).toBe('');
  });
});
