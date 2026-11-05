/** Web verifier adapter for the version 1 PassBook Android bridge. */
export class ReaderClient extends EventTarget {
  #bridge;
  #pending = new Set();
  capabilities = null;

  constructor(bridge = globalThis.PassBookNative) {
    super();
    if (!bridge) throw new Error('PassBook native bridge is unavailable.');
    this.#bridge = bridge;
    bridge.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || message.version !== 1) return;
      if (message.event === 'ready') {
        this.capabilities = message;
        this.dispatchEvent(new Event('ready'));
      } else if (message.event === 'scan' && typeof message.id === 'string') {
        this.#pending.clear();
        this.#pending.add(message.id);
        this.dispatchEvent(new CustomEvent('scan', { detail: message }));
      } else if (message.event === 'timeout' || message.event === 'cancelled') {
        this.#pending.clear();
        this.dispatchEvent(new Event(message.event));
      }
    };
  }

  connect() {
    this.#send({ op: 'hello' });
  }
  start() {
    this.#send({ op: 'start' });
  }
  stop() {
    this.#send({ op: 'stop' });
  }
  result(id, outcome) {
    if (!['accepted', 'rejected', 'error'].includes(outcome)) throw new Error('Invalid outcome.');
    if (!this.#pending.delete(id)) return false;
    this.#send({ op: 'result', id, outcome });
    return true;
  }
  dispose() {
    this.#bridge.onmessage = null;
    this.#pending.clear();
  }
  #send(message) {
    this.#bridge.postMessage(JSON.stringify({ version: 1, ...message }));
  }
}
