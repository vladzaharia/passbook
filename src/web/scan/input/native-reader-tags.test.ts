import { describe, expect, it, vi } from 'vitest';
import { connectNativeReader } from './native-reader.ts';
import type { ReadResult } from './native-settle.ts';

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = {
    postMessage: (s: string) => sent.push(JSON.parse(s)),
    onmessage: null as ((e: { data: string }) => void) | null,
  };
  const read = vi.fn((): ReadResult => ({ track: 'input-1' }));
  const cancelled = vi.fn();
  const unsupported = vi.fn();
  const capabilities = vi.fn();
  const client = connectNativeReader({ read, cancelled, unsupported, capabilities }, bridge);
  const event = (message: object) =>
    bridge.onmessage?.({ data: JSON.stringify({ version: 1, ...message }) });
  return { sent, bridge, read, cancelled, unsupported, capabilities, client, event };
}

describe('native scanner adapter, bridge v2 tags', () => {
  const tagScan = (extra: object = {}) => ({
    event: 'scan',
    id: 'n-tag',
    source: 'nfc-tag',
    tag: { uid: '04A2B3C4D5E6F7', uidRandom: false, tech: 'a', ...extra },
  });

  it('says hello with the versions it speaks and keeps v1 until the app answers', () => {
    const s = setup();
    expect(s.sent[0]).toEqual({
      version: 2,
      op: 'hello',
      versions: [1, 2],
      features: ['scanAck', 'scanSettle'],
    });
    expect(s.sent[1]).toEqual({ version: 1, op: 'stop' });
    s.client?.start();
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'start' });
    expect(s.client?.tags()).toBe(false);
    expect(s.client?.tagRead('Hold the tag')).toBeNull();
  });

  it('a v1 app never reads tags: a stray nfc-tag event is refused, not read', () => {
    const s = setup();
    s.event({ event: 'ready', capabilities: {} });
    s.event(tagScan());
    expect(s.read).not.toHaveBeenCalled();
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'result', id: 'n-tag', outcome: 'error' });
  });

  it('speaks the version the app answered with', () => {
    const s = setup();
    s.bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'ready', capabilities: {} }),
    });
    expect(s.client?.tags()).toBe(true);
    s.client?.setTagReading(true);
    s.client?.start();
    expect(s.sent.at(-1)).toEqual({ version: 2, op: 'start', formats: ['wallet-vas', 'tag'] });
    s.client?.stop();
    expect(s.sent.at(-1)).toEqual({ version: 2, op: 'stop', formats: ['wallet-vas', 'tag'] });
  });

  it('sends one tagRead at a time, capped at 60 s, and tagCancel ends it', () => {
    const s = setup();
    s.bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'ready', capabilities: {} }),
    });
    const id = s.client?.tagRead('Hold the tag near the top of the iPhone', 90_000);
    expect(s.sent.at(-1)).toEqual({
      version: 2,
      op: 'tagRead',
      id,
      prompt: 'Hold the tag near the top of the iPhone',
      timeoutMs: 60_000,
    });
    s.client?.tagCancel();
    expect(s.sent.at(-1)).toEqual({ version: 2, op: 'tagCancel', id });
    s.client?.tagCancel();
    expect(s.sent.filter((m) => m.op === 'tagCancel')).toHaveLength(1);
  });

  it('turns a tag scan into an nfc read with a lowercase uid and acknowledges after the verdict', () => {
    const s = setup();
    s.bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'ready', capabilities: {} }),
    });
    s.bridge.onmessage?.({ data: JSON.stringify({ version: 2, ...tagScan() }) });
    expect(s.read).toHaveBeenCalledWith({
      method: 'nfc',
      tag: { uid: '04a2b3c4d5e6f7', uidRandom: false, tech: 'a', source: 'native' },
    });
    expect(s.client?.result('input-1', 'accepted')).toBe(true);
    expect(s.sent.at(-1)).toEqual({ version: 2, op: 'result', id: 'n-tag', outcome: 'accepted' });
  });

  it('reports a sheet that ended without a tag', () => {
    const tagEnded = vi.fn();
    const sent: unknown[] = [];
    const bridge = {
      postMessage: (m: string) => sent.push(JSON.parse(m)),
      onmessage: null as ((e: { data: string }) => void) | null,
    };
    const client = connectNativeReader(
      {
        read: vi.fn(() => ({ error: true as const })),
        cancelled: vi.fn(),
        unsupported: vi.fn(),
        tagEnded,
      },
      bridge,
    );
    bridge.onmessage?.({ data: JSON.stringify({ version: 2, event: 'ready', capabilities: {} }) });
    client?.tagRead('Hold');
    bridge.onmessage?.({ data: JSON.stringify({ version: 2, event: 'cancelled' }) });
    expect(tagEnded).toHaveBeenCalledWith('cancelled');
    bridge.onmessage?.({ data: JSON.stringify({ version: 2, event: 'cancelled' }) });
    expect(tagEnded).toHaveBeenCalledTimes(1);
  });

  it('a cancelled that names the tag read ends it without failing a barcode check', () => {
    const s = setup();
    s.bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'ready', capabilities: {} }),
    });
    s.bridge.onmessage?.({
      data: JSON.stringify({ version: 2, event: 'scan', id: 'n-1', source: 'barcode', value: 'A' }),
    });
    const id = s.client?.tagRead('Hold');
    s.bridge.onmessage?.({ data: JSON.stringify({ version: 2, event: 'cancelled', id }) });
    expect(s.cancelled).not.toHaveBeenCalled();
    expect(s.client?.result('input-1', 'accepted')).toBe(true);
  });
});
