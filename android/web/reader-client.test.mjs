import assert from 'node:assert/strict';
import test from 'node:test';
import { ReaderClient } from './reader-client.js';

function fixture() {
  const sent = [];
  const bridge = { postMessage: (message) => sent.push(JSON.parse(message)) };
  const client = new ReaderClient(bridge);
  const receive = (message) =>
    bridge.onmessage({ data: JSON.stringify({ version: 1, ...message }) });
  return { sent, bridge, client, receive };
}

test('handshake and validated result round trip', () => {
  const { sent, client, receive } = fixture();
  client.connect();
  assert.deepEqual(sent[0], { version: 1, op: 'hello' });
  receive({ event: 'ready', nfc: true });
  assert.equal(client.capabilities.nfc, true);
  let scan;
  client.addEventListener('scan', (event) => {
    scan = event.detail;
  });
  receive({ event: 'scan', id: '1', source: 'barcode', value: '000123' });
  assert.equal(scan.value, '000123');
  client.result('1', 'accepted');
  assert.deepEqual(sent[1], { version: 1, op: 'result', id: '1', outcome: 'accepted' });
  assert.equal(client.result('1', 'accepted'), false);
});

test('legacy encrypted VAS scans and error results retain their v1 wire format', () => {
  const { sent, client, receive } = fixture();
  let scan;
  client.addEventListener('scan', (event) => {
    scan = event.detail;
  });
  receive({
    event: 'scan',
    id: 'vas',
    source: 'apple-vas',
    passTypeIdentifier: 'pass.example.member',
    cryptogram: 'AAAA',
  });
  assert.equal(scan.source, 'apple-vas');
  assert.equal(scan.passTypeIdentifier, 'pass.example.member');
  assert.equal(scan.cryptogram, 'AAAA');
  assert.equal(client.result('vas', 'error'), true);
  assert.deepEqual(sent[0], { version: 1, op: 'result', id: 'vas', outcome: 'error' });
});

test('capability updates preserve v1 fields and publish the latest snapshot', () => {
  const { client, receive } = fixture();
  const initial = {
    platform: 'android',
    appVersion: '0.2.3',
    camera: { available: true, permission: 'unknown' },
    keyboard: { supported: true, connected: null, connectionObservable: false },
    nfc: { available: true, reading: true, formats: ['wallet-vas'] },
    vas: {
      deviceSupported: true,
      available: false,
      reader: 'android-native',
      reason: 'No verifier',
    },
    externalReader: { mode: 'keyboard', connected: null },
    customerDisplay: { supported: false, available: false, active: false },
  };
  receive({
    event: 'ready',
    nfc: true,
    ecp: false,
    diagnostics: false,
    appVersion: '0.2.3',
    capabilities: initial,
  });
  let update;
  let count = 0;
  client.addEventListener('capabilities', (event) => {
    update = event.detail;
    count++;
  });
  receive({ event: 'scan', id: 'pending', source: 'barcode', value: '000123' });
  const next = {
    ...initial,
    camera: { available: true, permission: 'granted' },
    nfc: { ...initial.nfc, available: false, reading: false },
  };
  receive({ event: 'capabilities', capabilities: next });
  assert.deepEqual(update, next);
  assert.deepEqual(client.capabilities.capabilities, next);
  assert.equal(client.capabilities.nfc, false);
  assert.equal(client.capabilities.ecp, false);
  assert.equal(client.capabilities.diagnostics, false);
  assert.equal(client.capabilities.appVersion, '0.2.3');
  assert.equal(client.capabilities.capabilities.vas.available, false);
  assert.equal(client.result('pending', 'accepted'), true);
  receive({ event: 'capabilities', capabilities: null });
  receive({ event: 'capabilities', capabilities: [] });
  receive({ version: 2, event: 'capabilities', capabilities: initial });
  assert.equal(count, 1);
  assert.deepEqual(client.capabilities.capabilities, next);
});

test('timeouts and newer scans invalidate old decisions', () => {
  const { client, receive } = fixture();
  receive({ event: 'scan', id: '1' });
  receive({ event: 'scan', id: '2' });
  assert.equal(client.result('1', 'accepted'), false);
  assert.throws(() => client.result('2', 'something'), /outcome/);
  receive({ event: 'timeout' });
  assert.equal(client.result('2', 'accepted'), false);
  receive({ event: 'scan', id: '3' });
  receive({ event: 'cancelled' });
  assert.equal(client.result('3', 'accepted'), false);
});

test('malformed and wrong-version events are ignored and dispose detaches', () => {
  const { client, bridge, receive } = fixture();
  bridge.onmessage({ data: '{' });
  bridge.onmessage({ data: 'null' });
  receive({ version: 2, event: 'ready', nfc: true });
  assert.equal(client.capabilities, null);
  client.dispose();
  assert.equal(bridge.onmessage, null);
});
