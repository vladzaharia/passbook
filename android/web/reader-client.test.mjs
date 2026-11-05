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
