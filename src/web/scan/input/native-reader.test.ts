import { describe, expect, it, vi } from 'vitest';
import { connectNativeReader } from './native-reader.ts';

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = {
    postMessage: (s: string) => sent.push(JSON.parse(s)),
    onmessage: null as ((e: { data: string }) => void) | null,
  };
  const read = vi.fn(() => 'input-1');
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

  it('starts native hardware when the scan session starts', () => {
    const s = setup();
    s.client?.start();
    expect(s.sent.at(-1)).toEqual({ version: 1, op: 'start' });
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
