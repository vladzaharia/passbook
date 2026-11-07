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
