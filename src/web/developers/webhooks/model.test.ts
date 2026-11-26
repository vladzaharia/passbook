import { describe, expect, it } from 'vitest';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import {
  byNewest,
  captureRow,
  factsOfBody,
  findRow,
  narrow,
  stateWord,
  testRow,
  toneOfRow,
} from './model.ts';

const capture = (over: Partial<WebhookCaptureDto> = {}): WebhookCaptureDto => ({
  id: 'c1',
  endpointId: 'ep1',
  eventId: 'e1',
  type: 'pass.issued',
  trigger: 'event',
  status: 200,
  durationMs: 9,
  headers: {},
  body: JSON.stringify({ requestId: 'r1', pass: { id: 'p1', externalId: 'ext-1' } }),
  createdAt: 100,
  ...over,
});

describe('webhook rows', () => {
  it('reads the request and pass a capture names, and none from a broken body', () => {
    expect(factsOfBody(capture().body)).toEqual({
      requestId: 'r1',
      passId: 'p1',
      externalId: 'ext-1',
    });
    expect(factsOfBody('{oops')).toEqual({ requestId: null, passId: null, externalId: null });
  });

  it('names an event capture by its pass and the others by how they were made', () => {
    expect(captureRow(capture()).meta).toBe('ext-1');
    expect(captureRow(capture({ trigger: 'replay' })).meta).toBe('Replayed');
    expect(captureRow(capture({ trigger: 'test', body: '{}' })).meta).toBe('Sent from this page');
  });

  it('tones by the answer, and failed by state when there was none', () => {
    expect(toneOfRow(captureRow(capture()))).toBe('success');
    expect(toneOfRow(captureRow(capture({ status: 500 })))).toBe('danger');
    expect(toneOfRow({ ...captureRow(capture()), status: null, state: 'failed' })).toBe('danger');
    expect(toneOfRow({ ...captureRow(capture()), status: null, state: 'pending' })).toBe('neutral');
  });

  it('narrows by type and status, newest first', () => {
    const a = captureRow(capture({ id: 'a', createdAt: 1 }));
    const b = captureRow(capture({ id: 'b', createdAt: 2, status: 500, type: 'pass.updated' }));
    expect(byNewest([a, b]).map((r) => r.id)).toEqual(['b', 'a']);
    expect(narrow([a, b], { status: 'failed' }).map((r) => r.id)).toEqual(['b']);
    expect(narrow([a, b], { type: 'pass.issued', status: 'ok' }).map((r) => r.id)).toEqual(['a']);
  });

  it('finds a row by its id, or by the event id a Trace link carries', () => {
    const rows = [captureRow(capture())];
    expect(findRow(rows, 'c1')?.id).toBe('c1');
    expect(findRow(rows, 'e1')?.id).toBe('c1');
    expect(findRow(rows, 'nope')).toBeUndefined();
  });

  it('says Failed, not a bare state, for a test send nothing answered', () => {
    const row = testRow(
      {
        id: 't1',
        type: 'webhook.test',
        ok: false,
        status: null,
        errorCode: 'UPSTREAM',
        durationMs: 3,
        at: 5,
      },
      'ep2',
    );
    expect(stateWord(row)).toBe('Failed');
    expect(row.meta).toBe('Failed · UPSTREAM · 3 ms');
    expect(toneOfRow(row)).toBe('danger');
  });
});
