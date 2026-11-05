const bridge = window.PassBookNative;
if (bridge) {
  bridge.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.event === 'ready') {
      document.querySelector('#connection').textContent = message.nfc
        ? 'NFC and barcode reader connected'
        : 'Barcode reader connected · NFC unavailable';
      document.querySelector('#version').textContent = `PassBook Reader ${message.appVersion}`;
    }
    if (message.event === 'scan') {
      document.querySelector('#read').textContent =
        message.source === 'apple-vas'
          ? `Encrypted pass read · ${message.passTypeIdentifier} · unverified`
          : 'Barcode read · unverified';
      bridge.postMessage(JSON.stringify({ version: 1, op: 'captured', id: message.id }));
    }
  };
  bridge.postMessage(JSON.stringify({ version: 1, op: 'hello' }));
} else {
  document.querySelector('#connection').textContent = 'Open this page in PassBook Reader.';
}
