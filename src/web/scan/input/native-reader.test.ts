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

describe('native scanner adapter', () => {
  it('keeps leading zeroes and acknowledges only the matching server decision', () => {
    const s = setup();
    s.event({ event: 'scan', id: 'native-1', source: 'barcode', value: '000123' });
    expect(s.read).toHaveBeenCalledWith({ method: 'wedge', code: '000123' });
    expect(s.client?.result('other-input', 'accepted')).toBe(false);
    expect(s.sent.filter((m) => m.op === 'result')).toEqual([]);
    expect(s.client?.result('input-1', 'accepted')).toBe(true);
    expect(s.sent.at(-1)).toEqual({
      version: 1,
      op: 'result',
      id: 'native-1',
      outcome: 'accepted',
    });
    expect(s.client?.result('input-1', 'accepted')).toBe(false);
  });

  it('acknowledges receipt before any verdict, and keeps earlier reads pending', () => {
    const s = setup();
    s.event({ event: 'ready', features: ['scanAck'], capabilities: {} });
    s.read.mockReturnValueOnce({ track: 'input-1' }).mockReturnValueOnce({ track: 'input-2' });
    s.event({ event: 'scan', id: 'native-1', source: 'barcode', value: 'A' });
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'scanAck', id: 'native-1' });
    s.event({ event: 'scan', id: 'native-2', source: 'barcode', value: 'B' });
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'scanAck', id: 'native-2' });
    expect(s.sent.filter((m) => m.op === 'result')).toEqual([]);
    expect(s.cancelled).not.toHaveBeenCalled();
    expect(s.client?.result('input-1', 'accepted')).toBe(true);
    expect(s.sent.at(-1)).toMatchObject({ op: 'result', id: 'native-1' });
    expect(s.client?.result('input-2', 'rejected')).toBe(true);
  });

  it('acknowledges a scan the page refuses, then reports the error', () => {
    const s = setup();
    s.event({ event: 'ready', features: ['scanAck'], capabilities: {} });
    s.read.mockReturnValueOnce({ error: true });
    s.event({ event: 'scan', id: 'native-3', source: 'barcode', value: 'C' });
    expect(s.sent.slice(-2)).toEqual([
      { version: 1, op: 'scanAck', id: 'native-3' },
      { version: 1, op: 'result', id: 'native-3', outcome: 'error' },
    ]);
  });

  it('sends no ack to an app that did not advertise scanAck', () => {
    const s = setup();
    s.event({ event: 'ready', capabilities: {} });
    s.event({ event: 'scan', id: 'native-5', source: 'barcode', value: 'D' });
    expect(s.sent.filter((m) => m.op === 'scanAck')).toEqual([]);
    s.event({ event: 'ready', features: ['other'], capabilities: {} });
    s.event({ event: 'scan', id: 'native-6', source: 'barcode', value: 'E' });
    expect(s.sent.filter((m) => m.op === 'scanAck')).toEqual([]);
  });

  it('keeps the capability snapshot when the app sends features beside it', () => {
    const s = setup();
    s.event({ event: 'ready', features: ['scanAck'], capabilities: { platform: 'android' } });
    expect(s.capabilities).toHaveBeenCalledWith({ platform: 'android' });
  });

  it('does not acknowledge a malformed scan', () => {
    const s = setup();
    s.event({ event: 'ready', features: ['scanAck'], capabilities: {} });
    s.event({ event: 'scan', id: 'native-4', source: 'barcode' });
    expect(s.sent.filter((m) => m.op === 'scanAck')).toEqual([]);
  });

  it('starts native hardware when the scan session starts', () => {
    const s = setup();
    s.client?.start();
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'start' });
  });

  it('forwards generic accessory statuses without weakening native scan acknowledgements', () => {
    const s = setup();
    expect(s.client?.customerStatus('checking', 'camera-1')).toBe(false);
    s.event({
      event: 'ready',
      capabilities: {
        customerDisplay: { supported: true, available: true, active: true },
      },
    });
    expect(s.sent.at(-1)).toEqual({
      version: 1,
      op: 'customerStatus',
      status: 'checking',
    });
    expect(s.client?.customerStatus('checking', 'camera-1')).toBe(false);
    expect(s.client?.customerStatus('accepted', 'camera-1')).toBe(true);
    expect(s.sent.at(-1)).toEqual({
      version: 1,
      op: 'customerStatus',
      status: 'accepted',
    });
    expect(s.client?.customerStatus('ready')).toBe(false);
    expect(s.client?.result('camera-1', 'accepted')).toBe(false);
  });

  it('does not send customer display commands on Android or unsupported iOS', () => {
    const s = setup();
    s.event({
      event: 'ready',
      capabilities: {
        customerDisplay: { supported: false, available: false, active: false },
      },
    });
    expect(s.client?.customerStatus('checking', 'web-1')).toBe(false);
    expect(s.sent.filter((message) => message.op === 'customerStatus')).toEqual([]);
  });

  it('sends only validated display branding when the accessory is available', () => {
    const s = setup();
    const branding = {
      name: 'Northwind',
      accent: '#0f766e',
      logoSha: 'a'.repeat(64),
    };
    expect(s.client?.customerBranding(branding)).toBe(false);
    s.event({
      event: 'ready',
      capabilities: {
        customerDisplay: { supported: true, available: true, active: true },
      },
    });
    expect(s.sent.at(-1)).toEqual({
      version: 1,
      op: 'customerBranding',
      branding,
    });
    expect(s.client?.customerBranding({ ...branding, holder: 'Private pass data' })).toBe(false);
    expect(s.sent.at(-1)).toEqual({
      version: 1,
      op: 'customerBranding',
      branding,
    });
  });
  it('reports capabilities and preserves NFC as a distinct scan method', () => {
    const s = setup();
    const capabilities = { nfc: { ndefAvailable: true }, vas: { available: false } };
    s.event({ event: 'ready', capabilities });
    s.event({ event: 'scan', id: 'native-nfc', source: 'barcode', method: 'nfc', value: '123' });
    expect(s.capabilities).toHaveBeenCalledWith(capabilities);
    expect(s.read).toHaveBeenCalledWith({ method: 'nfc', code: '123' });
    s.client?.readNfc();
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'nfcRead' });
  });

  it.each(['timeout', 'cancelled'])('ignores late acceptance after %s', (event) => {
    const s = setup();
    s.event({ event: 'scan', id: 'native-1', source: 'barcode', value: '000123' });
    s.event({ event });
    expect(s.cancelled).toHaveBeenCalledWith('input-1');
    expect(s.client?.result('input-1', 'accepted')).toBe(false);
  });

  it('refuses raw VAS and malformed or wrong-version inputs', () => {
    const s = setup();
    s.event({ event: 'scan', id: 'native-2', source: 'apple-vas', cryptogram: 'ciphertext' });
    expect(s.read).not.toHaveBeenCalled();
    expect(s.unsupported).toHaveBeenCalledOnce();
    expect(s.sent.at(-1)).toMatchObject({ op: 'result', outcome: 'error' });
    s.event({ event: 'scan', id: 1, source: 'barcode', value: 'value' });
    s.event({ version: 2, event: 'scan', id: 'native-3', source: 'barcode', value: 'value' });
    expect(s.read).not.toHaveBeenCalled();
    s.client?.dispose();
    expect(s.bridge.onmessage).toBeNull();
  });
});

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
